'use strict';
/* ===============================
   IMPORT
================================ */
const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
require('moment/locale/th');

/* ===============================
   CONFIG
================================ */
const PORT = process.env.PORT || 3000;

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

if (!config.channelAccessToken || !config.channelSecret) {
  throw new Error('LINE ENV MISSING');
}

const client = new line.Client(config);
const app = express();

/* ===============================
   DATA FILE
================================ */
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSION_TIMEOUT = 15 * 60 * 1000; // 15 นาที
const ADMIN_IDS = ['U8e63ee87f7ac4c096116ed58836428b62'];
let users = {};
if (fs.existsSync(USERS_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE));
  } catch {
    users = {};
  }
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

/* ===============================
   HELPER
================================ */
function reply(event, text) {
  if (!event.replyToken) return;
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text
  });
}

function resetUser(userId) {
  users[userId] = {
    step: 'ask_name',
    lastActive: Date.now()
  };
  saveUsers();
}

/* ===============================
   MAIN HANDLER
================================ */
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const lower = text.toLowerCase();
  const now = Date.now();

  /* ===== ADMIN COMMAND ===== */
  if (ADMIN_IDS.includes(userId) && lower === 'admin') {
    return reply(
      event,
      `📊 Admin Panel\nผู้ใช้ทั้งหมด: ${Object.keys(users).length}`
    );
  }

  /* ===== CREATE USER ===== */
  if (!users[userId]) {
    resetUser(userId);
    return reply(event, 'สวัสดีครับ 😊\nขอทราบชื่อของคุณหน่อยครับ');
  }

  const user = users[userId];

  /* ===== TIMEOUT ===== */
  if (now - user.lastActive > SESSION_TIMEOUT) {
    resetUser(userId);
    return reply(
      event,
      'คุณหายไปสักพักนะครับ 😊\nขอเริ่มใหม่\nกรุณาพิมพ์ชื่อของคุณ'
    );
  }

  user.lastActive = now;
  saveUsers();

  /* ===== GLOBAL ===== */
  if (['เริ่มใหม่', 'reset', 'ล้างข้อมูล'].includes(lower)) {
    resetUser(userId);
    return reply(event, 'รีเซ็ตเรียบร้อยครับ 😊\nพิมพ์ชื่อของคุณได้เลย');
  }

  /* ===============================
     STEP : ASK NAME
  ================================ */
  if (user.step === 'ask_name') {
    if (
      text.length < 2 ||
      text.length > 20 ||
      !/^[ก-๙a-zA-Z\s]+$/.test(text)
    ) {
      return reply(
        event,
        '❌ กรุณาพิมพ์ชื่อจริง 2–20 ตัวอักษร (ไทย/อังกฤษ)'
      );
    }

    user.name = text;
    user.step = 'ask_age';
    saveUsers();

    return reply(event, `ยินดีที่ได้รู้จักครับ ${user.name} 😊\nคุณอายุเท่าไหร่ครับ`);
  }

  /* ===============================
     STEP : ASK AGE
  ================================ */
  if (user.step === 'ask_age') {
    const age = Number(text);
    if (!Number.isInteger(age) || age < 1 || age > 60) {
      return reply(event, '❌ กรุณาพิมพ์อายุเป็นตัวเลข 1–60');
    }

    user.age = age;
    user.step = 'ask_birthday';
    saveUsers();

    return reply(
      event,
      'วันเกิดของคุณวันไหนครับ?\nตัวอย่าง: 20/11/2548\nหรือพิมพ์ "ข้าม"'
    );
  }

  /* ===============================
     STEP : ASK BIRTHDAY
  ================================ */
  if (user.step === 'ask_birthday') {
    if (['ข้าม', 'skip'].includes(lower)) {
      user.birthday = null;
      user.step = 'done';
      saveUsers();
      return reply(event, `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 ${user.age} ปี`);
    }

    if (!moment(text, 'DD/MM/YYYY', true).isValid()) {
      return reply(event, '❌ รูปแบบวันเกิดไม่ถูกต้อง (DD/MM/YYYY)');
    }

    user.birthday = text;
    user.step = 'done';
    saveUsers();

    return reply(
      event,
      `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 ${user.age} ปี\n📅 ${user.birthday}`
    );
  }

  /* ===============================
     NORMAL MODE
  ================================ */
  if (lower.includes('วันเกิด')) {
    if (!user.birthday) {
      return reply(event, 'คุณยังไม่ได้บอกวันเกิดไว้ครับ');
    }

    const nowMoment = moment().tz('Asia/Bangkok');
    const [d, m] = user.birthday.split('/');
    let next = moment.tz(`${nowMoment.year()}-${m}-${d}`, 'Asia/Bangkok');

    if (next.isBefore(nowMoment, 'day')) {
      next.add(1, 'year');
    }

    const diff = next.diff(nowMoment, 'days');
    return reply(event, `🎂 อีก ${diff} วัน จะถึงวันเกิดของคุณครับ`);
  }

  return reply(event, 'ผมยังไม่เข้าใจครับ 😊 พิมพ์ "เริ่มใหม่" ได้เลย');
}

/* ===============================
   WEBHOOK
================================ */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

app.get('/', (req, res) => {
  res.send('LINE BOT RUNNING');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
