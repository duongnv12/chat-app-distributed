// notification-service/src/app.js
const express = require('express');
const amqp = require('amqplib');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3004; // Cổng HTTP cho health check
const WS_PORT = process.env.WS_PORT || 4000; // Cổng WebSocket cho client kết nối
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

// Khởi tạo WebSocket server
const wss = new WebSocket.Server({ port: WS_PORT });
console.log(`[WebSocket] Notification WebSocket Server listening on port ${WS_PORT}`);

wss.on('connection', (ws) => {
    console.log('[WebSocket] Client connected');
    ws.on('close', () => {
        console.log('[WebSocket] Client disconnected');
    });
});

// Hàm kết nối đến RabbitMQ và bắt đầu tiêu thụ tin nhắn
async function consumeMessages() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();
        console.log('[RabbitMQ] Connected to RabbitMQ from Notification Service');

        // Khai báo hàng đợi
        await channel.assertQueue('chat_messages', { durable: true });
        console.log('[RabbitMQ] Asserted queue: chat_messages for consuming');
        console.log('[RabbitMQ] Waiting for messages in chat_messages. To exit, press CTRL+C');

        channel.consume('chat_messages', (msg) => {
            if (msg !== null) {
                const content = msg.content.toString();
                console.log(`[Notification Service] Received message: "${content}"`);

                // Broadcast tới tất cả client WebSocket
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'NEW_MESSAGE',
                            data: JSON.parse(content)
                        }));
                    }
                });

                // Xử lý thông báo thực tế (nếu cần)
                console.log(`[Notification Service] Processing notification for message: "${content}"`);

                // Xác nhận đã xử lý tin nhắn
                channel.ack(msg);
                console.log(`[Notification Service] Acknowledged message: "${content}"`);
            }
        }, { noAck: false });

    } catch (error) {
        console.error('[RabbitMQ] Error connecting or consuming from RabbitMQ:', error.message);
        setTimeout(consumeMessages, 5000);
    }
}

// Gọi hàm để bắt đầu tiêu thụ tin nhắn khi service khởi động
consumeMessages();

// Một route HTTP đơn giản cho Health Check
app.get('/', (req, res) => {
    res.send('Notification Service is running and consuming messages.');
});

// Lắng nghe cổng HTTP (không liên quan đến WebSocket)
app.listen(PORT, () => {
    console.log(`Notification Service HTTP listening on port ${PORT}`);
});