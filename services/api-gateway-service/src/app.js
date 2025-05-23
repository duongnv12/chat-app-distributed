// api-gateway-service/src/app.js
require('dotenv').config(); // Đảm bảo đã chạy `npm install dotenv` và có file .env

const express = require('express');
const proxy = require('express-http-proxy');
const bodyParser = require('body-parser');
const cors = require('cors'); // Đảm bảo đã chạy `npm install cors`
const rateLimit = require('express-rate-limit'); // Đảm bảo đã chạy `npm install express-rate-limit`
const logger = require('./logger'); // <-- THÊM DÒNG NÀY

const app = express();
const PORT = process.env.PORT || 3000;

// Đọc URL của các service từ biến môi trường
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL;
const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL;

// Middleware CORS để cho phép frontend giao tiếp
app.use(cors());

// Middleware để phân tích cú pháp JSON trong request body
app.use(bodyParser.json());

// Cấu hình Rate Limiter cho các endpoint xác thực (đăng ký, đăng nhập)
// Giới hạn 500 yêu cầu mỗi IP trong 1 phút (để phát triển dễ dàng)
const authLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 phút
    max: 500, // Giới hạn mỗi IP tối đa 500 request
    message: { message: 'Too many authentication requests from this IP, please try again after 1 minute', code: 429 },
    standardHeaders: true, // Thêm các header `RateLimit-*` vào response
    legacyHeaders: false, // Vô hiệu hóa các header cũ
    handler: (req, res, next, options) => {
        logger.warn(`API Gateway: Rate limit hit for Auth requests from IP: ${req.ip}`);
        res.status(options.statusCode).send(options.message);
    }
});

// Cấu hình Rate Limiter chung cho các API khác
// Giới hạn 1000 yêu cầu mỗi IP trong 1 giờ
const apiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 giờ
    max: 1000, // Giới hạn mỗi IP tối đa 1000 request
    message: { message: 'Too many requests from this IP, please try again after an hour', code: 429 },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        logger.warn(`API Gateway: Rate limit hit for API requests from IP: ${req.ip}`);
        res.status(options.statusCode).send(options.message);
    }
});

// Áp dụng authLimiter cho các route đăng ký và đăng nhập
app.use('/auth/register', authLimiter);
app.use('/auth/login', authLimiter);

// Áp dụng apiLimiter cho tất cả các API khác (hiện tại là chat service)
app.use('/chat', apiLimiter);

// Proxy các yêu cầu đến Auth Service
app.use('/auth', proxy(AUTH_SERVICE_URL, {
    proxyReqPathResolver: function (req) {
        logger.debug(`API Gateway - Auth Proxy Request Body: ${JSON.stringify(req.body)}`);
        const url = req.url;
        logger.info(`API Gateway - Proxying Auth: ${req.method} /auth${url} -> ${AUTH_SERVICE_URL}${url}`);
        return url;
    },
    userResDecorator: function (proxyRes, proxyResData, userReq, userRes) {
        logger.info(`API Gateway - Received response from Auth Service: ${proxyRes.statusCode}`);
        return proxyResData;
    },
    proxyErrorHandler: function(err, res, next) {
        logger.error(`API Gateway - Auth Proxy Error: ${err.message}`, err);
        res.status(500).send('API Gateway: Auth service is unavailable.');
    }
}));

// Proxy các yêu cầu đến Chat Service
app.use('/chat', proxy(CHAT_SERVICE_URL, {
    proxyReqPathResolver: function (req) {
        logger.debug(`API Gateway - Chat Proxy Request Body: ${JSON.stringify(req.body)}`);
        const url = req.url;
        logger.info(`API Gateway - Proxying Chat: ${req.method} /chat${url} -> ${CHAT_SERVICE_URL}${url}`);
        return url;
    },
    userResDecorator: function (proxyRes, proxyResData, userReq, userRes) {
        logger.info(`API Gateway - Received response from Chat Service: ${proxyRes.statusCode}`);
        return proxyResData;
    },
    proxyErrorHandler: function(err, res, next) {
        logger.error(`API Gateway - Chat Proxy Error: ${err.message}`, err);
        res.status(500).send('API Gateway: Chat service is unavailable.');
    }
}));


// Xử lý lỗi 404 (Not Found)
app.use((req, res, next) => {
    logger.warn(`API Gateway: 404 Not Found - ${req.method} ${req.originalUrl}`);
    res.status(404).send('API Gateway: Endpoint not found');
});

// Xử lý lỗi chung
app.use((err, req, res, next) => {
    logger.error('API Gateway: An unhandled error occurred:', err.stack);
    res.status(500).send('API Gateway: Something broke!');
});

app.listen(PORT, () => {
    logger.info(`API Gateway Service running on port ${PORT}`);
    logger.info(`Proxying Auth Service to: ${AUTH_SERVICE_URL}`);
    logger.info(`Proxying Chat Service to: ${CHAT_SERVICE_URL}`);
});