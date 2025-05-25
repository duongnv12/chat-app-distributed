// src/App.js
import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { jwtDecode } from 'jwt-decode';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import './App.css'; // Import CSS styles

// Base URLs for your services
const API_GATEWAY_URL = 'http://localhost:3000';
const CHAT_SERVICE_WS_URL = 'http://localhost:3003';
const WS_NOTIFICATION_URL = 'ws://localhost:4000'; 

function App() {
    const [isRegistering, setIsRegistering] = useState(false);
    const [usernameInput, setUsernameInput] = useState('');
    const [password, setPassword] = useState('');
    const [token, setToken] = useState(localStorage.getItem('jwtToken') || '');
    const [messages, setMessages] = useState([]);
    const [newMessage, setNewMessage] = useState('');
    const [socket, setSocket] = useState(null);
    const [loggedInUsername, setLoggedInUsername] = useState('');
    const [socketStatus, setSocketStatus] = useState('Disconnected');

    const [currentRoom, setCurrentRoom] = useState('general');
    const [roomInput, setRoomInput] = useState('');

    const [searchTerm, setSearchTerm] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [searchLoading, setSearchLoading] = useState(false);

    const [typingUsers, setTypingUsers] = useState(new Set()); // Set để lưu trữ các username đang gõ
    const typingTimeoutRef = useRef(null); // Ref để quản lý timeout của trạng thái gõ

    const messageListRef = useRef(null); // Ref để tự động cuộn

    const notificationSocketRef = useRef(null);


    // Effect để tự động cuộn xuống dưới cùng khi có tin nhắn mới
    useEffect(() => {
        if (messageListRef.current) {
            messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
        }
    }, [messages]);

    // Effect để khởi tạo socket và lấy tin nhắn khi token hoặc phòng thay đổi
    useEffect(() => {
        if (token) {
            // Không toast 'Logged in successfully!' ở đây vì nó sẽ chạy lại mỗi khi currentRoom thay đổi
            // Chỉ toast khi lần đầu có token hoặc sau khi đăng nhập thành công.
            // Điều này được xử lý trong handleAuth.

            // Giải mã token để lấy username
            try {
                const decodedToken = jwtDecode(token);
                setLoggedInUsername(decodedToken.username || 'User');
                console.log('Decoded token:', decodedToken);
            } catch (decodeError) {
                console.error('Error decoding token:', decodeError);
                toast.error('Invalid token. Please log in again.');
                handleLogout();
                return;
            }

            // Khởi tạo kết nối Socket.IO
            setSocketStatus('Connecting...');
            const newSocket = io(CHAT_SERVICE_WS_URL, {
                auth: { token: token },
                transports: ['websocket', 'polling']
            });

            newSocket.on('connect', () => {
                console.log('Socket connected:', newSocket.id);
                setSocket(newSocket);
                setSocketStatus('Connected');
                newSocket.emit('joinRoom', currentRoom); // Yêu cầu join phòng
            });

            newSocket.on('disconnect', () => {
                console.log('Socket disconnected');
                setSocket(null);
                setSocketStatus('Disconnected');
                setTypingUsers(new Set()); // Xóa trạng thái gõ khi ngắt kết nối
            });

            newSocket.on('connect_error', (err) => {
                console.error('Socket connection error:', err.message);
                toast.error(`Socket connection failed: ${err.message}. Please check token.`);
                setSocketStatus('Error');
                setToken('');
                localStorage.removeItem('jwtToken');
            });

            newSocket.on('receiveMessage', (msg) => {
                console.log('Received message:', msg);
                setMessages((prevMessages) => {
                    if (msg.room === currentRoom) {
                        setTypingUsers(prev => {
                            const newSet = new Set(prev);
                            newSet.delete(msg.sender);
                            return newSet;
                        });
                        // Chỉ hiện toast nếu không phải tin nhắn của chính mình và phòng hiện tại
                        if (
                            msg.sender !== loggedInUsername &&
                            msg.room === currentRoom
                        ) {
                            const toastId = `msg-${msg.sender}-${msg.timestamp}`;
                            if (!toast.isActive(toastId)) {
                                toast.info(
                                    `${msg.sender}: ${msg.content}`,
                                    { autoClose: 3000, toastId }
                                );
                            }
                        }
                        return [...prevMessages, msg];
                    }
                    return prevMessages;
                });
            });

            newSocket.on('messageError', (errorMsg) => {
                toast.error(`Chat Error: ${errorMsg}`);
            });

            newSocket.on('joinedRoom', (roomName) => {
                toast.success(`Joined room: ${roomName}`);
                setTypingUsers(new Set()); // Reset trạng thái gõ khi chuyển phòng
                fetchMessages(token, roomName);
            });

            // Sự kiện khi có người dùng khác bắt đầu gõ
            newSocket.on('userTyping', (username) => {
                // console.log(`${username} is typing...`); // Debugging
                setTypingUsers(prev => new Set(prev).add(username));
            });

            // Sự kiện khi có người dùng khác ngừng gõ
            newSocket.on('userStoppedTyping', (username) => {
                // console.log(`${username} stopped typing.`); // Debugging
                setTypingUsers(prev => {
                    const newSet = new Set(prev);
                    newSet.delete(username);
                    return newSet;
                });
            });

            fetchMessages(token, currentRoom);

            return () => {
                newSocket.disconnect();
                // Clear any pending typing timeout on unmount
                if (typingTimeoutRef.current) {
                    clearTimeout(typingTimeoutRef.current);
                    typingTimeoutRef.current = null;
                }
            };
        } else {
            setMessages([]);
            setLoggedInUsername('');
            setSocketStatus('Disconnected');
            setTypingUsers(new Set());
            if (socket) {
                socket.disconnect();
                setSocket(null);
            }
        }
    }, [token, currentRoom]); // Chạy lại effect này khi token HOẶC currentRoom thay đổi

    const fetchMessages = async (currentToken, room) => {
        try {
            const response = await axios.get(`${API_GATEWAY_URL}/chat/messages?room=${room}`, {
                headers: { Authorization: `Bearer ${currentToken}` }
            });
            setMessages(response.data);
        } catch (err) {
            console.error('Error fetching messages:', err);
            if (err.response && err.response.status === 403) {
                toast.error('Failed to load messages. Your session might have expired. Please log in again.');
                handleLogout();
            } else {
                toast.error('Failed to load messages.');
            }
        }
    };

    useEffect(() => {
        // Kết nối tới Notification Service khi đã đăng nhập
        if (token) {
            const ws = new window.WebSocket(WS_NOTIFICATION_URL);
            notificationSocketRef.current = ws;

            ws.onopen = () => {
                console.log('Connected to Notification Service');
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'NEW_MESSAGE') {
                        // Chỉ hiện toast nếu không phải tin nhắn của chính mình và phòng khác phòng hiện tại
                        if (
                            msg.data.room !== currentRoom &&
                            msg.data.sender !== loggedInUsername
                        ) {
                            // Sử dụng toastId để tránh trùng
                            const toastId = `msg-${msg.data.sender}-${msg.data.timestamp}`;
                            if (!toast.isActive(toastId)) {
                                toast.info(
                                    `New message from ${msg.data.sender} in room "${msg.data.room}": ${msg.data.content}`,
                                    { autoClose: 4000, toastId }
                                );
                            }
                        }
                    }
                } catch (err) {
                    console.error('Error parsing notification:', err);
                }
            };

            ws.onclose = () => {
                console.log('Notification WebSocket closed');
            };

            ws.onerror = (err) => {
                console.error('Notification WebSocket error:', err);
            };

            return () => {
                ws.close();
            };
        }
    }, [token, currentRoom]);

    const handleAuth = async (endpoint) => {
        try {
            const response = await axios.post(`${API_GATEWAY_URL}/auth/${endpoint}`, { username: usernameInput, password });
            toast.success(response.data.message || 'Operation successful!', { autoClose: 2000 });
            if (response.data.token) {
                setToken(response.data.token);
                localStorage.setItem('jwtToken', response.data.token);
            }
        } catch (err) {
            console.error('Authentication error:', err.response?.data || err.message);
            toast.error(err.response?.data?.message || 'An error occurred during authentication.');
            setToken('');
            localStorage.removeItem('jwtToken');
        }
    };

    const handleRegister = () => handleAuth('register');
    const handleLogin = () => handleAuth('login');

    // Hàm để xử lý khi người dùng bắt đầu/ngừng gõ
    const handleTyping = () => {
        if (!socket || !socket.connected) return;

        // Gửi sự kiện 'typing'
        socket.emit('typing', currentRoom);

        // Xóa timeout cũ nếu có
        if (typingTimeoutRef.current) {
            clearTimeout(typingTimeoutRef.current);
        }

        // Đặt timeout để gửi 'stopTyping' nếu người dùng ngừng gõ trong một khoảng thời gian
        typingTimeoutRef.current = setTimeout(() => {
            socket.emit('stopTyping', currentRoom);
        }, 1500); // Ngừng gõ sau 1.5 giây không có thao tác bàn phím
    };

    const handleSendMessage = () => {
        if (socket && socket.connected && newMessage.trim()) {
            socket.emit('sendMessage', { room: currentRoom, content: newMessage.trim() });
            setNewMessage('');
            // Đảm bảo xóa timeout và gửi stopTyping ngay lập tức khi gửi tin nhắn
            if (typingTimeoutRef.current) {
                clearTimeout(typingTimeoutRef.current);
                typingTimeoutRef.current = null;
            }
            socket.emit('stopTyping', currentRoom); // Gửi stopTyping ngay lập tức
        } else if (!socket || !socket.connected) {
            toast.error('Not connected to chat. Please ensure you are logged in and socket is connected.');
        }
    };

    const handleJoinRoom = () => {
        if (socket && socket.connected && roomInput.trim()) {
            setCurrentRoom(roomInput.trim());
            socket.emit('joinRoom', roomInput.trim());
            setRoomInput('');
            setMessages([]); // Xóa tin nhắn cũ để hiển thị tin nhắn của phòng mới
            // toast.success(`Attempting to join room: ${roomInput.trim()}`); // Toast này đã được moved vào event 'joinedRoom'
        } else if (!socket || !socket.connected) {
            toast.error('Not connected to chat. Cannot join room.');
        }
    };

        // Hàm tìm kiếm người dùng
    const handleSearchUser = async () => {
        if (!searchTerm.trim()) return;
        setSearchLoading(true);
        try {
            const response = await axios.get(
                `${API_GATEWAY_URL}/auth/users/search?username=${encodeURIComponent(searchTerm)}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setSearchResults(response.data);
        } catch (err) {
            toast.error('Error searching users');
            setSearchResults([]);
        }
        setSearchLoading(false);
    };

    // Hàm join phòng chat 1-1
    const handleStartPrivateChat = (otherUser) => {
        // Tạo tên phòng private theo thứ tự alphabet để 2 user luôn vào cùng 1 phòng
        const users = [loggedInUsername, otherUser].sort();
        const privateRoom = `private_${users[0]}_${users[1]}`;
        setCurrentRoom(privateRoom);
        if (socket && socket.connected) {
            socket.emit('joinRoom', privateRoom);
            setMessages([]);
        }
        setSearchResults([]);
        setSearchTerm('');
    };

    const handleLogout = () => {
        setToken('');
        localStorage.removeItem('jwtToken');
        setUsernameInput('');
        setPassword('');
        setMessages([]);
        toast.success('Logged out successfully.', { autoClose: 2000 });
        setLoggedInUsername('');
        setSocketStatus('Disconnected');
        setTypingUsers(new Set()); // Xóa trạng thái gõ khi đăng xuất
        if (socket) {
            socket.disconnect();
            setSocket(null);
        }
    };

    if (!token) {
        return (
            <div className="container">
                <ToastContainer position="top-right" autoClose={3000} hideProgressBar={false} newestOnTop={false} closeOnClick rtl={false} pauseOnFocusLoss draggable pauseOnHover />
                <div className="main-chat" style={{ width: '100%' }}>
                    <h2>{isRegistering ? 'Register' : 'Login'}</h2>
                    <input
                        type="text"
                        placeholder="Username"
                        value={usernameInput}
                        onChange={(e) => setUsernameInput(e.target.value)}
                    />
                    <input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                    <button onClick={isRegistering ? handleRegister : handleLogin}>
                        {isRegistering ? 'Register' : 'Login'}
                    </button>
                    <button className="link-button" onClick={() => setIsRegistering(!isRegistering)}>
                        {isRegistering ? 'Already have an account? Login' : 'Need an account? Register'}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="container">
            <ToastContainer position="top-right" autoClose={3000} hideProgressBar={false} newestOnTop={false} closeOnClick rtl={false} pauseOnFocusLoss draggable pauseOnHover />
            {/* Sidebar bên trái */}
            <div className="sidebar">
                <div>
                    <h3>Welcome, {loggedInUsername}!</h3>
                    <button className="logout-button" onClick={handleLogout}>Logout</button>
                </div>
                {/* Tìm kiếm người dùng */}
                <div className="search-box">
                    <input
                        type="text"
                        placeholder="Search users..."
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        onKeyPress={e => { if (e.key === 'Enter') handleSearchUser(); }}
                        disabled={searchLoading}
                    />
                    <button onClick={handleSearchUser} disabled={searchLoading}>
                        {searchLoading ? '...' : 'Search'}
                    </button>
                </div>
                {/* Hiển thị kết quả tìm kiếm */}
                {searchResults.length > 0 && (
                    <div className="search-results">
                        <ul>
                            {searchResults.map(user => (
                                <li key={user._id}>
                                    <span>{user.username}</span>
                                    <button className="start-chat-btn" onClick={() => handleStartPrivateChat(user.username)}>
                                        Chat
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {/* Tham gia phòng */}
                <div className="room-input-container">
                    <input
                        type="text"
                        placeholder="Enter room name..."
                        value={roomInput}
                        onChange={(e) => setRoomInput(e.target.value)}
                        onKeyPress={(e) => { if (e.key === 'Enter') handleJoinRoom(); }}
                        disabled={!socket || !socket.connected}
                    />
                    <button onClick={handleJoinRoom} disabled={!socket || !socket.connected}>
                        Join
                    </button>
                </div>
                <div>
                    <h3>Current Room</h3>
                    <div style={{ color: '#6366f1', fontWeight: 600 }}>{currentRoom} <span style={{ color: '#64748b', fontWeight: 400 }}>({socketStatus})</span></div>
                </div>
            </div>
            {/* Khu vực chat bên phải */}
            <div className="main-chat">
                <div className="header">
                    <h2>Room: {currentRoom}</h2>
                </div>
                {typingUsers.size > 0 && (
                    <p className="typing-status">
                        {Array.from(typingUsers).filter(user => user !== loggedInUsername).join(', ')}{' '}
                        {Array.from(typingUsers).filter(user => user !== loggedInUsername).length === 1 ? 'is' : 'are'} typing...
                    </p>
                )}
                <div className="message-list" ref={messageListRef}>
                    {messages.map((msg, index) => (
                        <p
                            key={index}
                            className={`message-item ${msg.sender === loggedInUsername ? 'my-message' : ''}`}
                        >
                            <span className="timestamp">[{new Date(msg.timestamp).toLocaleTimeString()}]</span>
                            <strong>{msg.sender}</strong>: {msg.content}
                        </p>
                    ))}
                </div>
                <div className="message-input-container">
                    <input
                        type="text"
                        placeholder="Type a message..."
                        value={newMessage}
                        onChange={(e) => {
                            setNewMessage(e.target.value);
                            handleTyping();
                        }}
                        onKeyPress={(e) => { if (e.key === 'Enter') handleSendMessage(); }}
                        disabled={!socket || !socket.connected}
                    />
                    <button onClick={handleSendMessage} disabled={!socket || !socket.connected}>
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}

export default App;