// chat-service/src/app.js
require('dotenv').config(); // Đảm bảo đã chạy `npm install dotenv` và có file .env

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const cors = require('cors'); // Đảm bảo đã chạy `npm install cors`
const logger = require('./logger'); // <-- THÊM DÒNG NÀY

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Cho phép mọi origin, bạn có thể giới hạn lại trong production
        methods: ["GET", "POST"]
    }
});

const MONGODB_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(express.json()); // Sử dụng express.json() thay vì body-parser

// Kết nối MongoDB
mongoose.connect(MONGODB_URI)
    .then(() => logger.info('[Chat Service] Connected to MongoDB'))
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
        socket.user = decoded; // Gắn thông tin người dùng vào socket
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
    // Mặc định cho người dùng tham gia phòng 'general' khi kết nối
    socket.join(defaultRoom);
    logger.info(`[Chat Service] ${socket.user.username} joined room: ${defaultRoom}`);
    socket.emit('joinedRoom', defaultRoom);


    // Event để client tham gia một phòng cụ thể
    socket.on('joinRoom', (roomName) => {
        // Rời khỏi các phòng hiện tại (trừ phòng riêng của socket.id)
        socket.rooms.forEach(r => {
            if (r !== socket.id) {
                socket.leave(r);
                // Thông báo cho phòng cũ rằng người dùng này không còn gõ nữa
                io.to(r).emit('userStoppedTyping', socket.user.username);
                logger.info(`[Chat Service] ${socket.user.username} left room: ${r}`);
            }
        });

        // Tham gia phòng mới
        socket.join(roomName);
        logger.info(`[Chat Service] ${socket.user.username} joined room: ${roomName}`);
        socket.emit('joinedRoom', roomName); // Thông báo cho client đã tham gia phòng
    });


    // Gửi tin nhắn đến tất cả các client trong phòng hiện tại
    socket.on('sendMessage', async (data) => {
        const { room, content } = data;

        // Kiểm tra xem người gửi có ở trong phòng mà họ muốn gửi tin nhắn không
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
            await newMessage.save(); // Lưu tin nhắn vào DB

            // Gửi tin nhắn mới đến tất cả các client đang kết nối trong phòng cụ thể
            io.to(room).emit('receiveMessage', newMessage);
            logger.info(`[Chat Service] Message broadcasted to room ${room}: ${newMessage.content}`);

            // Sau khi gửi tin nhắn, người dùng ngừng gõ
            io.to(room).emit('userStoppedTyping', socket.user.username);
        } catch (error) {
            logger.error('[Chat Service] Error saving or broadcasting message:', error);
            socket.emit('messageError', 'Failed to send message.');
        }
    });

    // Event khi người dùng bắt đầu gõ
    socket.on('typing', (roomName) => {
        if (!socket.rooms.has(roomName)) {
            logger.warn(`[Chat Service] User ${socket.user.username} attempted to send typing status to room ${roomName} without being in it.`);
            return;
        }
        // Phát sự kiện 'userTyping' cho tất cả client TRONG CÙNG PHÒNG, TRỪ CHÍNH MÌNH
        socket.to(roomName).emit('userTyping', socket.user.username);
    });

    // Event khi người dùng ngừng gõ
    socket.on('stopTyping', (roomName) => {
        if (!socket.rooms.has(roomName)) {
            logger.warn(`[Chat Service] User ${socket.user.username} attempted to send stopTyping status to room ${roomName} without being in it.`);
            return;
        }
        // Phát sự kiện 'userStoppedTyping' cho tất cả client TRONG CÙNG PHÒNG, TRỪ CHÍNH MÌNH
        socket.to(roomName).emit('userStoppedTyping', socket.user.username);
    });

    // Xử lý khi client ngắt kết nối
    socket.on('disconnect', () => {
        logger.info(`[Chat Service] User disconnected via WebSocket: ${socket.user ? socket.user.username : 'Unknown'} (Socket ID: ${socket.id})`);
        // Khi người dùng ngắt kết nối, cũng cần thông báo họ ngừng gõ ở tất cả các phòng họ đang ở
        socket.rooms.forEach(room => {
            // Đảm bảo không gửi đến phòng riêng của socket
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