const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const amqp = require('amqplib');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

let clients = [];
let channel;
const directExchange = 'direct_message_exchange';
const chatQueue = 'chat_messages';

async function connectRabbitMQ() {
    try {
        const connection = await amqp.connect({
            protocol: 'amqp',
            hostname: 'localhost',  // Replace with your RabbitMQ hostname or IP address
            port: 5672,
            username: 'guest',
            password: 'guest',
            vhost: '/',
            heartbeat: 60,
            reconnect: true,
        });
        channel = await connection.createChannel();

        await channel.assertExchange(directExchange, 'direct', { durable: true });

        await channel.assertQueue(chatQueue, { durable: true });

        // Binding the queue to the direct exchange
        await channel.bindQueue(chatQueue, directExchange, '');

        channel.consume(chatQueue, (msg) => {
            if (msg !== null) {
                const message = JSON.parse(msg.content.toString());
                handleMessage(message.username, message.content, message.clientId);
                channel.ack(msg);
            }
        });

        console.log('Connected to RabbitMQ');
    } catch (error) {
        console.error('Error connecting to RabbitMQ', error);
        setTimeout(connectRabbitMQ, 5000); // Retry connection after 5 seconds
    }
}

async function sendMessageToRabbitMQ(username, content, clientId, target) {
    try {
        const message = JSON.stringify({ username, content, clientId, target });
        await channel.publish(directExchange, target, Buffer.from(message), { persistent: true });
        console.log('Direct message sent to RabbitMQ:', message);
    } catch (error) {
        console.error('Error sending message to RabbitMQ', error);
    }
}

function handleMessage(username, content, clientId) {
    const message = { type: 'message', username, content, timestamp: new Date(), clientId };
    broadcastMessage(message);
}

function broadcastMessage(message, excludingWs) {
    const serializedMessage = JSON.stringify(message);
    clients.forEach(client => {
        if (client.ws !== excludingWs && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(serializedMessage);
        }
    });
}

function handleLogin(ws, username) {
    clients.push({ ws, username, clientId: generateClientId() });
    broadcastUserList();
}

function handleWebSocketMessage(ws, username, content, target) {
    const clientId = clients.find(client => client.ws === ws)?.clientId;
    const message = { type: 'message', username, content, timestamp: new Date(), clientId, target };
    if (target) {
        sendMessageToRabbitMQ(username, content, clientId, target);
    } else {
        console.log('Target user not specified for direct message.');
    }
}

function broadcastUserList() {
    const userList = clients.map(client => client.username);
    const message = { type: 'userList', userList };
    broadcastMessage(message);
}

function generateClientId() {
    return 'client-' + Math.random().toString(36).substr(2, 16);
}

wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (message) => {
        const parsedMessage = JSON.parse(message);
        switch (parsedMessage.type) {
            case 'login':
                handleLogin(ws, parsedMessage.username);
                break;
            case 'message':
                handleWebSocketMessage(ws, parsedMessage.username, parsedMessage.content, parsedMessage.target);
                break;
            default:
                console.log('Unsupported message type');
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        clients = clients.filter(client => client.ws !== ws);
        broadcastUserList();
    });
});

app.post('/api/send-message', async (req, res) => {
    const { username, content, target } = req.body;
    const clientId = clients.find(client => client.username === username)?.clientId || generateClientId();
    try {
        await sendMessageToRabbitMQ(username, content, clientId, target);
        res.status(200).send('Message sent');
    } catch (error) {
        console.error('Error sending message to RabbitMQ', error);
        res.status(500).send('Error sending message');
    }
});

const PORT = process.env.PORT || 9005;

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

connectRabbitMQ(); // Start RabbitMQ connection when the server starts
