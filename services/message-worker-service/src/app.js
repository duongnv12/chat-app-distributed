// message-worker-service/src/app.js
require('dotenv').config(); // Tải biến môi trường từ file .env

const amqp = require('amqplib'); // Thư viện AMQP client cho RabbitMQ
const logger = require('./logger'); // Import logger đã cấu hình Winston

const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://localhost'; // URI kết nối RabbitMQ
const QUEUE_NAME = 'chat_messages'; // Tên hàng đợi mà worker này sẽ lắng nghe

const WebSocket = require('ws');
const WS_NOTIFICATION_URL = process.env.WS_NOTIFICATION_URL || 'ws://localhost:4000';
let wsClient = null;

// Kết nối tới Notification WebSocket Server
function connectWebSocket() {
    wsClient = new WebSocket(WS_NOTIFICATION_URL);

    wsClient.on('open', () => {
        logger.info('Worker: Connected to Notification WebSocket Server');
    });

    wsClient.on('close', () => {
        logger.warn('Worker: WebSocket connection closed. Reconnecting in 5s...');
        setTimeout(connectWebSocket, 5000);
    });

    wsClient.on('error', (err) => {
        logger.error('Worker: WebSocket error:', err);
        wsClient.close();
    });
}

// Khởi động kết nối WebSocket ngay khi worker start
connectWebSocket();

// Hàm chính để khởi động worker và lắng nghe tin nhắn
async function startWorker() {
    try {
        // Kết nối đến RabbitMQ server
        const connection = await amqp.connect(RABBITMQ_URI);

        // Xử lý lỗi kết nối
        connection.on('error', (err) => {
            logger.error('Worker: RabbitMQ Connection Error:', err);
            // Nếu có lỗi, cố gắng kết nối lại sau 5 giây
            setTimeout(startWorker, 5000);
        });

        // Xử lý khi kết nối bị đóng
        connection.on('close', () => {
            logger.warn('Worker: RabbitMQ Connection Closed. Reconnecting...');
            // Nếu kết nối đóng, cố gắng kết nối lại sau 5 giây
            setTimeout(startWorker, 5000);
        });

        // Tạo một kênh (channel) để giao tiếp với RabbitMQ
        const channel = await connection.createChannel();

        // Đảm bảo hàng đợi tồn tại. durable: true để đảm bảo hàng đợi không bị mất khi RabbitMQ khởi động lại
        await channel.assertQueue(QUEUE_NAME, { durable: true });
        logger.info(`Worker: Connected to RabbitMQ and waiting for messages in queue: ${QUEUE_NAME}`);

        // Thiết lập prefetch (số lượng tin nhắn tối đa mà worker có thể xử lý cùng lúc)
        // prefetch(1) nghĩa là worker chỉ nhận 1 tin nhắn tại một thời điểm
        // cho đến khi nó xác nhận (ack) đã xử lý xong tin nhắn đó.
        channel.prefetch(1);

        // Bắt đầu tiêu thụ tin nhắn từ hàng đợi
        channel.consume(QUEUE_NAME, (msg) => {
            if (msg !== null) { // Đảm bảo tin nhắn không rỗng
                try {
                    // Chuyển đổi nội dung tin nhắn từ Buffer sang JSON object
                    const messageContent = JSON.parse(msg.content.toString());
                    logger.info(`Worker: Received message from queue: ${JSON.stringify(messageContent)}`);

                    // Gửi thông báo qua WebSocket nếu kết nối đang mở
                    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                        wsClient.send(JSON.stringify({
                            type: 'NEW_MESSAGE',
                            data: messageContent
                        }));
                        logger.info('Worker: Sent notification via WebSocket');
                    } else {
                        logger.warn('Worker: WebSocket not connected, cannot send notification');
                    }

                    // Giả lập thời gian xử lý tin nhắn (ví dụ: 1 giây)
                    setTimeout(() => {
                        logger.info(`Worker: Finished processing message from ${messageContent.sender} in room ${messageContent.room}: "${messageContent.content}"`);
                        // Xác nhận đã xử lý tin nhắn thành công. Tin nhắn sẽ bị xóa khỏi hàng đợi.
                        channel.ack(msg);
                    }, 1000); // Giả lập thời gian xử lý 1 giây

                } catch (error) {
                    logger.error('Worker: Error processing message from queue:', error);
                    // Nếu có lỗi trong quá trình xử lý, nack (negative acknowledgement) tin nhắn.
                    // third parameter 'true' means: re-queue the message.
                    // Nếu không re-queue (false), tin nhắn sẽ bị loại bỏ hoặc chuyển sang dead-letter queue (nếu cấu hình)
                    channel.nack(msg, false, true);
                }
            }
        });

    } catch (error) {
        logger.error('Worker: Failed to start RabbitMQ worker:', error);
        // Nếu không thể kết nối ngay từ đầu, cố gắng kết nối lại sau 5 giây
        setTimeout(startWorker, 5000);
    }
}

// Gọi hàm để khởi động worker khi ứng dụng bắt đầu
startWorker();