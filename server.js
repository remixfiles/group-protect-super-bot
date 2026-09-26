require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');

const app = express();
// ছবির Base64 সাইজের জন্য লিমিট বাড়ানো হয়েছে
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// Health Check রুট (UptimeRobot পিংয়ের জন্য)
app.get('/', (req, res) => {
  res.status(200).send('GroupControl Bot is alive and active!');
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ১. মিউটেড ইউজার স্কিমা (৩ দিনের TTL ইনডেক্স সহ)
const mutedUserSchema = new mongoose.Schema({
  groupId: { type: String, required: true, index: true },
  userId: { type: Number, required: true },
  name: { type: String, default: "User" },
  username: { type: String, default: "" },
  reason: { type: String, default: "Spam" },
  mutedAt: { type: Date, default: Date.now, expires: 259200 }
});
const MutedUser = mongoose.model('MutedUser', mutedUserSchema);

// ২. গ্রুপ সেটিংস স্কিমা
const groupSchema = new mongoose.Schema({
  groupId: { type: String, required: true, unique: true },
  groupTitle: { type: String, default: "Unknown Group" },
  antiSpam: { type: Boolean, default: true },
  antiFlood: { type: Boolean, default: true },
  antiForward: { type: Boolean, default: true },
  lastAutoMsgId: { type: Number, default: null }, // আগের অটো মেসেজ আইডি
  lastBroadcastAt: { type: Date, default: null }, // শেষ পাঠানোর সময়
  addedAt: { type: Date, default: Date.now }
});
const Group = mongoose.model('Group', groupSchema);

// ৩. অটো ব্রডকাস্ট কনফিগ স্কিমা
const broadcastSchema = new mongoose.Schema({
  imageData: { type: String, default: "" }, // Base64 বা Image URL
  text: { type: String, default: "" },
  buttons: { type: Array, default: [] }, // [[ {text, url}, {text, url} ], [ ... ]]
  updatedAt: { type: Date, default: Date.now }
});
const BroadcastConfig = mongoose.model('BroadcastConfig', broadcastSchema);

let groupConfigCache = new Map();

async function refreshCache() {
  try {
    const groups = await Group.find({});
    groupConfigCache.clear();
    groups.forEach(g => {
      groupConfigCache.set(String(g.groupId), {
        antiSpam: g.antiSpam,
        antiFlood: g.antiFlood,
        antiForward: g.antiForward !== false
      });
    });
  } catch (err) {
    console.error("Cache refresh error:", err.message);
  }
}

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("Connected to MongoDB Atlas");
    await refreshCache();
    start12HourScheduler(); // অটো শিডিউলার চালু
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

// মিউটেড ইউজার সেভ করার ফাংশন
async function recordMutedUser(chatId, userId, name, username, reason) {
  try {
    const sChatId = String(chatId);
    await MutedUser.deleteMany({ groupId: sChatId, userId: Number(userId) });
    await MutedUser.create({
      groupId: sChatId,
      userId: Number(userId),
      name: name || "User",
      username: username || "",
      reason: reason,
      mutedAt: new Date()
    });
  } catch (err) {
    console.error("Error recording muted user:", err.message);
  }
}

// ---------------- ১২ ঘণ্টার অটো-শিডিউলার ইঞ্জিন ---------------- //
async function executeBroadcastJob() {
  try {
    const config = await BroadcastConfig.findOne({});
    if (!config || (!config.imageData && !config.text)) return;

    const groups = await Group.find({});
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    const now = Date.now();

    for (const group of groups) {
      const lastSent = group.lastBroadcastAt ? new Date(group.lastBroadcastAt).getTime() : 0;
      
      // ১২ ঘণ্টা পার হলে অথবা আগে কখনোই না পাঠানো হলে
      if (now - lastSent >= twelveHoursMs) {
        
        // ১. আগের মেসেজ থাকলে ডিলিট করা
        if (group.lastAutoMsgId) {
          await callTelegram('deleteMessage', {
            chat_id: group.groupId,
            message_id: group.lastAutoMsgId
          });
        }

        // ২. ইনলাইন কিবোর্ড ফরম্যাট তৈরি
        const replyMarkup = {
          inline_keyboard: (config.buttons || []).map(row => 
            row.filter(b => b.text && b.url).map(b => ({
              text: b.text,
              url: b.url.startsWith('http') ? b.url : `https://${b.url}`
            }))
          ).filter(row => row.length > 0)
        };

        let newMsgId = null;

        // ৩. ছবি থাকলে sendPhoto, না থাকলে sendMessage
        if (config.imageData) {
          const sent = await callTelegram('sendPhoto', {
            chat_id: group.groupId,
            photo: config.imageData,
            caption: config.text || "",
            reply_markup: replyMarkup.inline_keyboard.length > 0 ? replyMarkup : undefined
          });
          if (sent && sent.ok) newMsgId = sent.result.message_id;
        } else {
          const sent = await callTelegram('sendMessage', {
            chat_id: group.groupId,
            text: config.text || "📢 Notice",
            reply_markup: replyMarkup.inline_keyboard.length > 0 ? replyMarkup : undefined
          });
          if (sent && sent.ok) newMsgId = sent.result.message_id;
        }

        // ৪. নতুন মেসেজ আইডি ও টাইম ডাটাবেজে সংরক্ষণ
        if (newMsgId) {
          await Group.updateOne(
            { groupId: group.groupId },
            { 
              lastAutoMsgId: newMsgId, 
              lastBroadcastAt: new Date() 
            }
          );
        }
      }
    }
  } catch (err) {
    console.error("Auto broadcast error:", err.message);
  }
}

function start12HourScheduler() {
  // সার্ভার রান হওয়ার ৩০ সেকেন্ড পর প্রথম চেক
  setTimeout(executeBroadcastJob, 30000);
  // প্রতি ৩ মিনিট পর পর টাইমিং চেক করবে
  setInterval(executeBroadcastJob, 3 * 60 * 1000);
}

// ---------------- TELEGRAM WEBHOOK ---------------- //
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  if (!update.message) return;

  const msg = update.message;
  const chatId = String(msg.chat.id);
  const userId = msg.from.id;
  const messageId = msg.message_id;

  const groupConfig = groupConfigCache.get(chatId);
  if (!groupConfig) return;
  if (msg.from.is_bot) return;

  try {
    const memberInfo = await callTelegram('getChatMember', { chat_id: chatId, user_id: userId });
    const isAdmin = memberInfo && ['creator', 'administrator'].includes(memberInfo.result?.status);
    if (isAdmin) return;

    const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || "User";
    const userHandle = msg.from.username || "";

    // ১. ANTI-FORWARD CONTROL
    const isForwarded = Boolean(
      msg.forward_origin || 
      msg.forward_from || 
      msg.forward_from_chat || 
      msg.forward_sender_name || 
      msg.forward_date
    );

    if (groupConfig.antiForward && isForwarded) {
      await callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
      const untilDate = Math.floor(Date.now() / 1000) + (3 * 24 * 60 * 60);
      await callTelegram('restrictChatMember', {
        chat_id: chatId,
        user_id: userId,
        until_date: untilDate,
        permissions: { can_send_messages: false }
      });

      await recordMutedUser(chatId, userId, userName, userHandle, "Forwarded Msg (3D Mute)");
      return;
    }

    // ২. SPAM CONTROL
    if (groupConfig.antiSpam) {
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

        await recordMutedUser(chatId, userId, userName, userHandle, "Spam (Link/Mention)");
        return;
      }
    }

    // ৩. FLOOD CONTROL
    if (groupConfig.antiFlood) {
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

        await recordMutedUser(chatId, userId, userName, userHandle, "Flood (6+ msg / 3s)");
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err.message);
  }
});

// ---------------- ADMIN API ---------------- //
const authMiddleware = (req, res, next) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: "ভুল পাসওয়ার্ড!" });
  }
  next();
};

app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const groups = await Group.find({}).sort({ addedAt: -1 }).lean();
    for (let group of groups) {
      const muted = await MutedUser.find({ groupId: group.groupId }).sort({ mutedAt: -1 });
      group.mutedUsers = muted;
    }
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/add', authMiddleware, async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ success: false, message: "Group ID প্রয়োজন।" });

  try {
    const chatData = await callTelegram('getChat', { chat_id: groupId });
    const groupTitle = chatData?.result?.title || "Unknown Group";

    const newGroup = await Group.findOneAndUpdate(
      { groupId: String(groupId) },
      { groupId: String(groupId), groupTitle },
      { upsert: true, new: true }
    );

    await refreshCache();
    res.json({ success: true, group: newGroup });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/delete', authMiddleware, async (req, res) => {
  const { groupId } = req.body;
  try {
    await Group.deleteOne({ groupId: String(groupId) });
    await MutedUser.deleteMany({ groupId: String(groupId) });
    await refreshCache();
    res.json({ success: true, message: "গ্রুপ মুছে ফেলা হয়েছে।" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/toggle', authMiddleware, async (req, res) => {
  const { groupId, feature, value } = req.body;
  if (!groupId || !feature) {
    return res.status(400).json({ success: false, message: "তথ্য অসম্পূর্ণ।" });
  }

  try {
    const updateQuery = {};
    updateQuery[feature] = Boolean(value);

    const updated = await Group.findOneAndUpdate(
      { groupId: String(groupId) },
      updateQuery,
      { new: true }
    );

    await refreshCache();
    res.json({ success: true, group: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/groups/unmute', authMiddleware, async (req, res) => {
  const { groupId, userId } = req.body;
  if (!groupId || !userId) {
    return res.status(400).json({ success: false, message: "Group ID ও User ID প্রয়োজন।" });
  }

  try {
    await callTelegram('restrictChatMember', {
      chat_id: groupId,
      user_id: userId,
      permissions: {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true
      }
    });

    await MutedUser.deleteMany({ groupId: String(groupId), userId: Number(userId) });
    res.json({ success: true, message: "ইউজারকে সফলভাবে আনমিউট করা হয়েছে!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/make-admin', authMiddleware, async (req, res) => {
  const { groupId, userId } = req.body;
  if (!groupId || !userId) {
    return res.status(400).json({ success: false, message: "Group ID ও User ID প্রয়োজন।" });
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
    res.json({ success: true, message: "সফলভাবে অ্যাডমিন করা হয়েছে!" });
  } else {
    res.status(400).json({ success: false, message: result?.description || "ব্যর্থ হয়েছে।" });
  }
});

// ---------------- ব্রডকাস্ট কনফিগারেশন API ---------------- //
app.post('/api/broadcast/get', authMiddleware, async (req, res) => {
  try {
    let config = await BroadcastConfig.findOne({});
    if (!config) {
      config = await BroadcastConfig.create({ imageData: "", text: "", buttons: [[]] });
    }
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/broadcast/save', authMiddleware, async (req, res) => {
  const { imageData, text, buttons } = req.body;
  try {
    let config = await BroadcastConfig.findOne({});
    if (!config) {
      config = new BroadcastConfig();
    }
    config.imageData = imageData || "";
    config.text = text || "";
    config.buttons = buttons || [];
    config.updatedAt = new Date();
    await config.save();

    res.json({ success: true, message: "ব্রডকাস্ট শিডিউলার সেটিংস সেভ হয়েছে!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));