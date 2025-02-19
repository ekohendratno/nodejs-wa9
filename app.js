const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const fileUpload = require('express-fileupload');
const axios = require('axios');


const port = process.env.PORT || 8000;


const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));

app.use(fileUpload({
  debug: false
}));

app.get('/', (req, res) => {
  res.sendFile('index-multiple-account.html', {
    root: __dirname
  });
});

const sessions = [];
const SESSIONS_FILE = './whatsapp-sessions.json';

const createSessionsFileIfNotExists = function () {
  if (!fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
      console.log('Sessions file created successfully.');
    } catch (err) {
      console.log('Failed to create sessions file: ', err);
    }
  }
}

createSessionsFileIfNotExists();

const setSessionsFile = function (sessions) {
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function (err) {
    if (err) {
      console.log(err);
    }
  });
}

const getSessionsFile = function () {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE));
}

const createSession = function (id, description) {
  console.log('Creating session: ' + id);
  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // <- this one doesn't works in Windows
        '--disable-gpu'
      ],
    },
    authStrategy: new LocalAuth({
      clientId: id
    })
  });

  client.initialize();

  client.on('qr', (qr) => {
    console.log(`qr ${id}`);
    // console.log('QR RECEIVED', qr);
    qrcode.toDataURL(qr, (err, url) => {
      io.emit('qr', { id: id, src: url });
      io.emit('message', { id: id, text: 'QR Code received, scan please!' });
    });
  });

  client.on('ready', () => {
    console.log(`ready ${id}`);
    io.emit('ready', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is ready!' });

    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions[sessionIndex].ready = true;
    setSessionsFile(savedSessions);
  });

  client.on('authenticated', () => {
    console.log(`authenticated ${id}`);
    io.emit('authenticated', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is authenticated!' });
  });

  client.on('auth_failure', function () {
    console.log(`auth_failure ${id}`);
    io.emit('message', { id: id, text: 'Auth failure, restarting...' });
  });

  client.on('disconnected', (reason) => {
    console.log(`disconnected ${id}`);
    io.emit('message', { id: id, text: 'Whatsapp is disconnected!' });

    client.destroy();
    client.initialize();

    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions.splice(sessionIndex, 1);
    setSessionsFile(savedSessions);

    io.emit('remove-session', id);
  });

  sessions.push({
    id: id,
    description: description,
    client: client
  });

  const savedSessions = getSessionsFile();
  const sessionIndex = savedSessions.findIndex(sess => sess.id == id);

  if (sessionIndex == -1) {
    savedSessions.push({
      id: id,
      description: description,
      ready: false,
    });
    setSessionsFile(savedSessions);
  }
}

const init = function (socket) {
  const savedSessions = getSessionsFile();

  if (savedSessions.length > 0) {
    if (socket) {
      savedSessions.forEach((e, i, arr) => {
        const liveSession = sessions.find(sess => sess.id === e.id);
        arr[i].ready = liveSession ? liveSession.client.info?.pushname !== undefined : e.ready;
      });

      socket.emit('init', savedSessions);
    } else {
      savedSessions.forEach(sess => {
        createSession(sess.id, sess.description);
      });
    }
  }
}

init();

io.on('connection', function (socket) {
  init(socket);

  socket.on('create-session', async function (data) {
    console.log('Create session: ' + data.id);
    createSession(data.id, data.description);
  });
});


app.post('/send-message', async (req, res) => {

  const id = req.body.id;
  const recipient = req.body.recipient;
  const message = req.body.message;
  const isGroup = req.body.group;

  const client = sessions.find(sess => sess.id == id)?.client;

  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The id: ${id} is not found!`
    })
  }

  if (isGroup) {

    try {
      await client.sendMessage(`${recipient}@g.us`, message);
      res.status(200).send({
        status: true,
        message: "Message sent to group successfully."
      });
    } catch (error) {
      res.status(500).send({
        status: false,
        message: "Failed to send message to group."
      });
    }

  } else {

    const number = phoneNumberFormatter(recipient);
    const isRegisteredNumber = await client.isRegisteredUser(number);

    if (!isRegisteredNumber) {
      return res.status(422).json({
        status: false,
        message: 'The number is not registered'
      });
    }

    try {
      await client.sendMessage(number, message);
      res.status(200).send({
        status: true,
        message: "Message sent successfully."
      });
    } catch (error) {
      res.status(500).send({
        status: false,
        message: "Failed to send message."
      });
    }
  }
});


app.get('/list-group', async (req, res) => {

  const id = req.body.id;

  const client = sessions.find(sess => sess.id == id)?.client;

  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The id: ${id} is not found!`
    })
  }


  try {
    const chats = await client.getChats();
    const groupChats = chats.filter(chat => chat.id.server === "g.us");
    const filteredGroups = [];

    for (const group of groupChats) {
      const messages = await group.fetchMessages({ limit: 50 });
      const today = new Date().toISOString().split("T")[0];
      const hasRegisterMessage = messages.some(msg => {
        const messageDate = new Date(msg.timestamp * 1000).toISOString().split("T")[0];
        return msg.body === "/register";// && messageDate === today;
      });

      if (hasRegisterMessage) {
        filteredGroups.push({
          id: group.id._serialized,
          name: group.name || "Unknown Group",
        });
      }
    }

    res.status(200).json({ 
      status: true, 
      groups: filteredGroups,
      message: "Group has to listed." 
    });
  } catch (error) {
    res.status(500).send({
      status: false,
      message: "Failed to fetch groups."
    });
  }

});


server.listen(port, function () {
  console.log('App running on http://localhost:' + port);
});
