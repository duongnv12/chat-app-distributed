// chat-service/src/app.js
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const logger = require('./logger'); // Logger đã tích hợp Winston
const amqp = require('amqplib'); // <-- Thư viện AMQP client cho RabbitMQ

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Cho phép tất cả các nguồn gốc (hoặc cụ thể hơn cho sản phẩm)
        methods: ["GET", "POST"]
    }
});

const MONGODB_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3003;
const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://localhost'; // URI kết nối RabbitMQ

let rabbitmqChannel = null; // Biến để lưu trữ kênh RabbitMQ

app.use(cors());
app.use(express.json());

// Kết nối MongoDB (Replica Set)
mongoose.connect(MONGODB_URI)
    .then(() => logger.info('[Chat Service] Connected to MongoDB Replica Set'))
    .catch(err => logger.error('[Chat Service] Could not connect to MongoDB:', err));

// Định nghĩa Schema và Model cho tin nhắn
const MessageSchema = new mongoose.Schema({
    sender: {
        type: String,
        required: true
    },
    content: {
        type: String,
        required: true
    },
    room: {
        type: String,
        required: true,
        default: 'general'
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
});

const Message = mongoose.model('Message', MessageSchema);

// Hàm kết nối và tạo kênh RabbitMQ
async function connectRabbitMQ() {
    try {
        const connection = await amqp.connect(RABBITMQ_URI);
        // Xử lý lỗi kết nối
        connection.on('error', (err) => {
            logger.error('[Chat Service] RabbitMQ Connection Error:', err);
            // Cố gắng kết nối lại sau một thời gian
            setTimeout(connectRabbitMQ, 5000);
        });
        // Xử lý khi kết nối bị đóng
        connection.on('close', () => {
            logger.warn('[Chat Service] RabbitMQ Connection Closed. Reconnecting...');
            // Cố gắng kết nối lại sau một thời gian
            setTimeout(connectRabbitMQ, 5000);
        });

        rabbitmqChannel = await connection.createChannel();
        // Đảm bảo hàng đợi tồn tại và bền vững (durable: true)
        await rabbitmqChannel.assertQueue('chat_messages', { durable: true });
        logger.info('[Chat Service] Connected to RabbitMQ and asserted queue: chat_messages');
    } catch (error) {
        logger.error('[Chat Service] Failed to connect to RabbitMQ:', error);
        // Cố gắng kết nối lại sau một thời gian
        setTimeout(connectRabbitMQ, 5000);
    }
}

// Gọi hàm kết nối RabbitMQ khi khởi động service
connectRabbitMQ();

// Middleware xác thực JWT cho Socket.IO
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        logger.warn('Chat Service: Authentication error - Token not provided for socket connection.');
        return next(new Error('Authentication error: Token not provided'));
    }
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            logger.warn('Chat Service: Authentication error - Invalid token for socket connection.', err);
            return next(new Error('Authentication error: Invalid token'));
        }
        socket.user = decoded;
        next();
    });
});

// Endpoint HTTP để lấy lịch sử tin nhắn (yêu cầu xác thực JWT)
const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader) {
        const token = authHeader.split(' ')[1];
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) {
                logger.warn('Chat Service: JWT verification failed for HTTP request.', err);
                return res.status(403).json({ message: 'Invalid or expired token.' });
            }
            req.user = user;
            next();
        });
    } else {
        logger.warn('Chat Service: Authorization token required for HTTP request.');
        res.status(401).json({ message: 'Authorization token required.' });
    }
};

app.get('/messages', authenticateJWT, async (req, res) => {
    const { room } = req.query;
    if (!room) {
        logger.warn('Chat Service: Room parameter missing for message fetch.');
        return res.status(400).send({ message: 'Room parameter is required.' });
    }
    logger.info(`[Chat Service] Fetching messages for user: ${req.user.username} in room: ${room}`);
    try {
        const messages = await Message.find({ room }).sort({ timestamp: 1 }).limit(100);
        res.status(200).send(messages);
    } catch (error) {
        logger.error('[Chat Service] Error fetching messages:', error);
        res.status(500).send({ message: 'Error fetching messages.' });
    }
});

// Xử lý kết nối Socket.IO
io.on('connection', (socket) => {
    logger.info(`[Chat Service] User connected via WebSocket: ${socket.user.username} (Socket ID: ${socket.id})`);

    const defaultRoom = 'general';
    socket.join(defaultRoom);
    logger.info(`[Chat Service] ${socket.user.username} joined room: ${defaultRoom}`);
    socket.emit('joinedRoom', defaultRoom);


    socket.on('joinRoom', (roomName) => {
        socket.rooms.forEach(r => {
            if (r !== socket.id) {
                socket.leave(r);
                io.to(r).emit('userStoppedTyping', socket.user.username);
                logger.info(`[Chat Service] ${socket.user.username} left room: ${r}`);
            }
        });

        socket.join(roomName);
        logger.info(`[Chat Service] ${socket.user.username} joined room: ${roomName}`);
        socket.emit('joinedRoom', roomName);
    });


    socket.on('sendMessage', async (data) => {
        const { room, content } = data;

        if (!socket.rooms.has(room)) {
            logger.warn(`[Chat Service] User ${socket.user.username} attempted to send message to room ${room} without being in it.`);
            socket.emit('messageError', 'You are not in this room.');
            return;
        }

        logger.info(`[Chat Service] Message received from ${socket.user.username} for room ${room}: ${content}`);
        if (!content || typeof content !== 'string' || content.trim() === '') {
            logger.warn('[Chat Service] Invalid message content received - empty or non-string.');
            socket.emit('messageError', 'Message content cannot be empty.');
            return;
        }

        try {
            const newMessage = new Message({
                sender: socket.user.username,
                content: content,
                room: room
            });
            await newMessage.save(); // Lưu tin nhắn vào MongoDB

            io.to(room).emit('receiveMessage', newMessage); // Broadcast tin nhắn thời gian thực qua Socket.IO
            logger.info(`[Chat Service] Message broadcasted to room ${room}: ${newMessage.content}`);

            // Gửi tin nhắn vào RabbitMQ sau khi lưu vào DB và broadcast qua Socket.IO
            if (rabbitmqChannel) {
                rabbitmqChannel.sendToQueue(
                    'chat_messages', // Tên hàng đợi
                    Buffer.from(JSON.stringify(newMessage)), // Nội dung tin nhắn (phải là Buffer)
                    { persistent: true } // Đảm bảo tin nhắn bền vững (không bị mất khi RabbitMQ khởi động lại)
                );
                logger.info(`[Chat Service] Message published to RabbitMQ queue 'chat_messages': ${newMessage.content}`);
            } else {
                logger.warn('[Chat Service] RabbitMQ channel not available. Message not published to queue.');
            }

            io.to(room).emit('userStoppedTyping', socket.user.username);
        } catch (error) {
            logger.error('[Chat Service] Error saving, broadcasting, or publishing message:', error);
            socket.emit('messageError', 'Failed to send message.');
        }
    });

    socket.on('typing', (roomName) => {
        if (!socket.rooms.has(roomName)) {
            logger.warn(`[Chat Service] User ${socket.user.username} attempted to send typing status to room ${roomName} without being in it.`);
            return;
        }
        socket.to(roomName).emit('userTyping', socket.user.username);
    });

    socket.on('stopTyping', (roomName) => {
        if (!socket.rooms.has(roomName)) {
            logger.warn(`[Chat Service] User ${socket.user.username} attempted to send stopTyping status to room ${roomName} without being in it.`);
            return;
        }
        socket.to(roomName).emit('userStoppedTyping', socket.user.username);
    });

    socket.on('disconnect', () => {
        logger.info(`[Chat Service] User disconnected via WebSocket: ${socket.user ? socket.user.username : 'Unknown'} (Socket ID: ${socket.id})`);
        socket.rooms.forEach(room => {
            if (room !== socket.id && socket.user && socket.user.username) {
                io.to(room).emit('userStoppedTyping', socket.user.username);
            }
        });
    });
});

// Xử lý lỗi 404 (Not Found)
app.use((req, res, next) => {
    logger.warn(`Chat Service: 404 Not Found - ${req.method} ${req.originalUrl}`);
    res.status(404).send('Chat Service: Endpoint not found');
});

// Xử lý lỗi chung
app.use((err, req, res, next) => {
    logger.error('Chat Service: An unhandled error occurred:', err.stack);
    res.status(500).send('Chat Service: Something broke!');
});

server.listen(PORT, () => {
    logger.info(`Chat Service running on port ${PORT}`);
});