// auth-service/src/app.js
require('dotenv').config(); // Đảm bảo đã chạy `npm install dotenv` và có file .env

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors'); // Đảm bảo đã chạy `npm install cors`
const logger = require('./logger'); // <-- THÊM DÒNG NÀY

const app = express();
const MONGODB_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json()); // Sử dụng express.json() thay vì body-parser

// Kết nối MongoDB
mongoose.connect(MONGODB_URI)
    .then(() => logger.info('Auth Service: Connected to MongoDB'))
    .catch(err => logger.error('Auth Service: Could not connect to MongoDB:', err));

// Định nghĩa Schema và Model cho người dùng
const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    }
});

UserSchema.pre('save', async function (next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    next();
});

const User = mongoose.model('User', UserSchema);

// Route đăng ký người dùng mới
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            logger.warn(`Auth Service: Registration attempt for existing username: ${username}`);
            return res.status(409).json({ message: 'Username already exists.' });
        }
        const user = new User({ username, password });
        await user.save();
        logger.info(`Auth Service: User registered: ${username}`);
        res.status(201).json({ message: 'User registered successfully.' });
    } catch (err) {
        logger.error('Auth Service: Registration failed:', err);
        res.status(500).json({ message: 'Registration failed.' });
    }
});

// Route đăng nhập
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user) {
            logger.warn(`Auth Service: Login attempt with non-existent username: ${username}`);
            return res.status(400).json({ message: 'Invalid credentials.' });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            logger.warn(`Auth Service: Login attempt with incorrect password for user: ${username}`);
            return res.status(400).json({ message: 'Invalid credentials.' });
        }

        const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });
        logger.info(`Auth Service: User logged in: ${username}`);
        res.status(200).json({ message: 'Login successful.', token });
    } catch (err) {
        logger.error('Auth Service: Login failed:', err);
        res.status(500).json({ message: 'Login failed.' });
    }
});

// Xử lý lỗi 404 (Not Found)
app.use((req, res, next) => {
    logger.warn(`Auth Service: 404 Not Found - ${req.method} ${req.originalUrl}`);
    res.status(404).send('Auth Service: Endpoint not found');
});

// Xử lý lỗi chung
app.use((err, req, res, next) => {
    logger.error('Auth Service: An unhandled error occurred:', err.stack);
    res.status(500).send('Auth Service: Something broke!');
});


app.listen(PORT, () => {
    logger.info(`Auth Service running on port ${PORT}`);
});