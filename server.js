require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// UptimeRobot / Health Check পিং রুট (যাতে Render স্লিপে না যায়)
app.get('/', (req, res) => {
  res.status(200).send('GroupControl Bot is alive and active!');
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// MongoDB স্কিমা
const groupSchema = new mongoose.Schema({
  groupId: { type: String, required: true, unique: true },
  groupTitle: { type: String, default: "Unknown Group" },
  addedAt: { type: Date, default: Date.now }
});
const Group = mongoose.model('Group', groupSchema);

let authorizedGroupIds = new Set();

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("Connected to MongoDB Atlas");
    const groups = await Group.find({});
    groups.forEach(g => authorizedGroupIds.add(String(g.groupId)));
  })
  .catch(err => console.error("MongoDB Error:", err));

const floodTracker = new Map();

async function callTelegram(method, data) {
  try {
    const res = await axios.post(`${TELEGRAM_API}/${method}`, data);
    return res.data;
  } catch (error) {
    console.error(`Telegram API Error (${method}):`, error.response?.data?.description || error.message);
    return null;
  }
}

// টেলিগ্রাম ওয়েবহুক
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  if (!update.message) return;

  const msg = update.message;
  const chatId = String(msg.chat.id);
  const userId = msg.from.id;
  const messageId = msg.message_id;

  if (!authorizedGroupIds.has(chatId)) return;
  if (msg.from.is_bot) return;

  try {
    const memberInfo = await callTelegram('getChatMember', { chat_id: chatId, user_id: userId });
    const isAdmin = memberInfo && ['creator', 'administrator'].includes(memberInfo.result?.status);
    if (isAdmin) return;

    // ১. Spam Control (Link & Mention)
    let isSpam = false;
    if (msg.entities) {
      isSpam = msg.entities.some(e => ['url', 'text_link', 'mention'].includes(e.type));
    }
    const content = (msg.text || msg.caption || "");
    if (!isSpam && (/@\w+|https?:\/\/[^\s]+|t\.me\/[^\s]+/i.test(content))) {
      isSpam = true;
    }

    if (isSpam) {
      await callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
      const untilDate = Math.floor(Date.now() / 1000) + (3 * 24 * 60 * 60);
      await callTelegram('restrictChatMember', {
        chat_id: chatId,
        user_id: userId,
        until_date: untilDate,
        permissions: { can_send_messages: false }
      });
      return;
    }

    // ২. Flood Control (৩ সেকেন্ডে ৬+ মেসেজ)
    const now = Date.now();
    const trackKey = `${chatId}:${userId}`;
    let userTimestamps = floodTracker.get(trackKey) || [];

    userTimestamps = userTimestamps.filter(t => now - t <= 3000);
    userTimestamps.push(now);
    floodTracker.set(trackKey, userTimestamps);

    if (userTimestamps.length >= 6) {
      const untilDate = Math.floor(Date.now() / 1000) + (5 * 60);
      await callTelegram('restrictChatMember', {
        chat_id: chatId,
        user_id: userId,
        until_date: untilDate,
        permissions: { can_send_messages: false }
      });
      floodTracker.delete(trackKey);
    }
  } catch (err) {
    console.error("Webhook processing error:", err.message);
  }
});

// এডমিন API অথেনটিকেশন মিডলওয়্যার
const authMiddleware = (req, res, next) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: "ভুল পাসওয়ার্ড!" });
  }
  next();
};

// অনুমোদিত গ্রুপের লিস্ট
app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const groups = await Group.find({}).sort({ addedAt: -1 });
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// নতুন গ্রুপ যোগ
app.post('/api/groups/add', authMiddleware, async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ success: false, message: "Group ID প্রয়োজন।" });

  try {
    const chatData = await callTelegram('getChat', { chat_id: groupId });
    const groupTitle = chatData?.result?.title || "Unknown Group";

    const newGroup = await Group.findOneAndUpdate(
      { groupId: String(groupId) },
      { groupId: String(groupId), groupTitle },
      { upsert: true, new: true }
    );

    authorizedGroupIds.add(String(groupId));
    res.json({ success: true, group: newGroup });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// গ্রুপ ডিলিট
app.post('/api/groups/delete', authMiddleware, async (req, res) => {
  const { groupId } = req.body;
  try {
    await Group.deleteOne({ groupId: String(groupId) });
    authorizedGroupIds.delete(String(groupId));
    res.json({ success: true, message: "গ্রুপ সরানো হয়েছে।" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Make Admin
app.post('/api/make-admin', authMiddleware, async (req, res) => {
  const { groupId, userId } = req.body;
  if (!groupId || !userId) {
    return res.status(400).json({ success: false, message: "Group ID ও User ID প্রয়োজন।" });
  }

  const result = await callTelegram('promoteChatMember', {
    chat_id: groupId,
    user_id: userId,
    can_manage_chat: true,
    can_delete_messages: true,
    can_manage_video_chats: true,
    can_restrict_members: true,
    can_promote_members: false,
    can_change_info: true,
    can_invite_users: true,
    can_pin_messages: true
  });

  if (result && result.ok) {
    res.json({ success: true, message: "সফলভাবে অ্যাডমিন করা হয়েছে!" });
  } else {
    res.status(400).json({ success: false, message: result?.description || "ব্যর্থ হয়েছে।" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));