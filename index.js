'use strict';
require('dotenv').config();
/* ===============================
   IMPORT
================================ */
const express = require('express');
const bodyParser = require('body-parser');
const line = require('@line/bot-sdk');

const reply = require('./reply');
const admin = require('./admin');
const logger = require('./logger');

/* ===============================
   CONFIG
================================ */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

/* ===============================
   APP INIT
================================ */
const app = express();
app.use(bodyParser.json());

/* ===============================
   WEBHOOK
================================ */
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events;

    // กัน request แปลก
    if (!events || !Array.isArray(events)) {
      logger.error('Invalid webhook payload');
      return res.status(400).send('Bad Request');
    }

    logger.info(`Incoming events: ${JSON.stringify(events)}`);

    for (const event of events) {
      await handleEvent(event);
    }

    res.status(200).send('OK');
  } catch (err) {
    logger.error(`Webhook fatal error: ${err.stack}`);
    res.status(500).send('ERROR');
  }
});

/* ===============================
   EVENT HANDLER
================================ */
async function handleEvent(event) {
  try {
    // ไม่ใช่ข้อความ → ข้าม
    if (!event.message || event.message.type !== 'text') {
      logger.info('Non-text event ignored');
      return;
    }

    const userId = event.source?.userId || 'unknown';
    const text = event.message.text.trim();

    logger.info(`USER(${userId}): ${text}`);

    /* ===== ADMIN COMMAND ===== */
    if (text.startsWith('/admin')) {
      await admin(event);
      return;
    }

    /* ===== NORMAL USER ===== */
    await reply(event);

  } catch (err) {
    logger.error(`handleEvent error: ${err.stack}`);

    // fallback กันบอทเงียบ
    if (event.replyToken) {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '⚠️ ระบบมีปัญหาชั่วคราว กรุณาลองใหม่อีกครั้ง'
      });
    }
  }
}

/* ===============================
   HEALTH CHECK
================================ */
app.get('/', (req, res) => {
  res.send('STC Chatbot is running ✅');
});

/* ===============================
   START SERVER
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
});
