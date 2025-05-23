// src/logger.js
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize, align } = format;

const logFormat = printf(({ level, message, timestamp, stack }) => {
    return `${timestamp} [${level}] ${stack || message}`;
});

const logger = createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug', // Level log theo môi trường
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        // Errors with stack trace
        format.errors({ stack: true }),
        logFormat
    ),
    transports: [
        new transports.Console({
            format: combine(
                colorize(), // Thêm màu sắc cho console
                align(),    // Căn chỉnh cho đẹp
                logFormat
            )
        }),
        // Trong môi trường production, bạn có thể thêm transports khác ở đây
        // Ví dụ: new transports.File({ filename: 'combined.log' })
        // Hoặc transports.MongoDB, transports.Http để gửi log tập trung
    ],
    // Exit on error (chỉ trong production)
    exitOnError: false,
});

// Nếu không phải production, cũng log ra console với level debug
if (process.env.NODE_ENV !== 'production') {
    logger.add(new transports.Console({
        format: combine(
            colorize(),
            align(),
            logFormat
        )
    }));
}

module.exports = logger;