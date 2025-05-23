// notification-service/src/app.js
const express = require('express');
const amqp = require('amqplib'); // Import amqplib

const app = express();
const PORT = process.env.PORT || 3004; // Cổng cho Notification Service (chọn cổng khác biệt)
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

// Hàm kết nối đến RabbitMQ và bắt đầu tiêu thụ tin nhắn
async function consumeMessages() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();
        console.log('[RabbitMQ] Connected to RabbitMQ from Notification Service');

        // Khai báo hàng đợi (cần đảm bảo hàng đợi tồn tại)
        // Cần 'durable: true' để đảm bảo nó khớp với hàng đợi đã tạo bởi Chat Service
        await channel.assertQueue('chat_messages', { durable: true });
        console.log('[RabbitMQ] Asserted queue: chat_messages for consuming');

        console.log('[RabbitMQ] Waiting for messages in chat_messages. To exit, press CTRL+C');

        // Bắt đầu tiêu thụ tin nhắn từ hàng đợi
        // noAck: false => cần gửi xác nhận (ack) sau khi xử lý xong tin nhắn
        channel.consume('chat_messages', (msg) => {
            if (msg !== null) {
                const content = msg.content.toString();
                console.log(`[Notification Service] Received message: "${content}"`);

                // Đây là nơi bạn sẽ thêm logic xử lý thông báo thực tế
                // Ví dụ: gửi push notification tới người dùng, lưu vào DB, v.v.
                console.log(`[Notification Service] Processing notification for message: "${content}"`);

                // Xác nhận đã xử lý tin nhắn
                // Rất quan trọng: Nếu không có ack, tin nhắn sẽ không bị xóa khỏi hàng đợi
                channel.ack(msg);
                console.log(`[Notification Service] Acknowledged message: "${content}"`);
            }
        }, { noAck: false });

    } catch (error) {
        console.error('[RabbitMQ] Error connecting or consuming from RabbitMQ:', error.message);
        // Tái kết nối nếu có lỗi
        setTimeout(consumeMessages, 5000);
    }
}

// Gọi hàm để bắt đầu tiêu thụ tin nhắn khi service khởi động
consumeMessages();

// Một route HTTP đơn giản cho Health Check
app.get('/', (req, res) => {
    res.send('Notification Service is running and consuming messages.');
});

// Lắng nghe cổng HTTP (không liên quan đến việc tiêu thụ tin nhắn RabbitMQ)
app.listen(PORT, () => {
    console.log(`Notification Service listening on port ${PORT}`);
});