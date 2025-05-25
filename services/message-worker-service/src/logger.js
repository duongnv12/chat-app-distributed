// src/logger.js
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize, align } = format;

const logFormat = printf(({ level, message, timestamp, stack }) => {
    if (stack) {
        return `<span class="math-inline">\{timestamp\} \[</span>{level}] <span class="math-inline">\{message\}\\n</span>{stack}`;
    }
    return `<span class="math-inline">\{timestamp\} \[</span>{level}] ${message}`;
});

const logger = createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.errors({ stack: true }),
        logFormat
    ),
    transports: [
        new transports.Console({
            format: combine(
                colorize({ all: true }),
                align(),
                logFormat
            )
        }),
    ],
    exitOnError: false,
});

module.exports = logger;