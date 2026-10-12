require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

// gramjs inline Button
let TgButton = null;
try { TgButton = require("telegram").Button || null; } catch (e) {}
if (!TgButton) { try { TgButton = require("telegram/tl/custom/button").Button; } catch (e) {} }
function buildPrimeButtons() {
    try {
        if (!TgButton || typeof TgButton.url !== "function") return null;
        return [
            [TgButton.url("🚀 Auto Quest (3s) @Ppmod_bot", "https://t.me/Ppmod_bot")],
            [TgButton.url("📢 Official Channel", "https://t.me/googleplaypointhack")],
            [TgButton.url("💬 Support", "https://t.me/Blackmoney54")],
        ];
    } catch (e) { return null; }
}

// ---------------- 1. EXPRESS HTTP SERVER & PING ROUTES ----------------
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.status(200).send("PP MOD Master Engine Active!"));
app.get("/ping", (req, res) => res.status(200).send("pong"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", uptime: process.uptime() }));

// ---------------- SMS GATEWAY PARSER & AUTO APPROVAL ----------------
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "PPMOD_GATEWAY_SEC_2025";

function parseSmsBody(sender, body) {
    if (!body) return null;
    let text = body.replace(/\n/g, " ");
    let method = null, trxId = null, amount = null;

    if (/bkash/i.test(sender) || /bkash/i.test(text)) {
        method = "bKash";
        let trxMatch = text.match(/TrxID\s+([A-Za-z0-9]+)/i) || text.match(/\b([A-Z0-9]{10})\b/);
        let amtMatch = text.match(/Tk\s+([\d,]+(?:\.\d+)?)/i) || text.match(/Amount:\s*Tk\s*([\d,]+)/i);
        if (trxMatch) trxId = trxMatch[1].trim();
        if (amtMatch) amount = parseFloat(amtMatch[1].replace(/,/g, ""));
    } else if (/nagad/i.test(sender) || /nagad/i.test(text)) {
        method = "Nagad";
        let trxMatch = text.match(/TxnID:\s*([A-Za-z0-9]+)/i) || text.match(/\b([A-Z0-9]{8,10})\b/);
        let amtMatch = text.match(/Tk\s+([\d,]+(?:\.\d+)?)/i) || text.match(/Amount:\s*Tk\s*([\d,]+)/i);
        if (trxMatch) trxId = trxMatch[1].trim();
        if (amtMatch) amount = parseFloat(amtMatch[1].replace(/,/g, ""));
    } else if (/rocket|16216/i.test(sender) || /rocket/i.test(text)) {
        method = "Rocket";
        let trxMatch = text.match(/TxnId:\s*([A-Za-z0-9]+)/i) || text.match(/Txn:\s*([A-Za-z0-9]+)/i);
        let amtMatch = text.match(/Tk\s*([\d,]+(?:\.\d+)?)/i);
        if (trxMatch) trxId = trxMatch[1].trim();
        if (amtMatch) amount = parseFloat(amtMatch[1].replace(/,/g, ""));
    }

    if (trxId && amount) {
        return { method, trxId: trxId.toUpperCase(), amount };
    }
    return null;
}

// Android App SMS Receiver Webhook
app.post("/api/gateway/sms", async (req, res) => {
    const secret = req.headers["x-gateway-secret"] || req.body.secret;
    if (secret !== GATEWAY_SECRET) {
        return res.status(401).json({ ok: false, error: "Unauthorized Gateway App" });
    }

    const { sender, message, timestamp } = req.body;
    if (!message) return res.status(400).json({ ok: false, error: "No message" });

    const parsed = parseSmsBody(sender || "", message);
    if (!parsed) {
        return res.json({ ok: true, matched: false, message: "Ignored (not payment SMS)" });
    }

    const cleanTrx = parsed.trxId.toUpperCase();

    try {
        await db.collection("gateway_sms").doc(cleanTrx).set({
            sender: sender || "Unknown",
            raw: message,
            method: parsed.method,
            trxId: cleanTrx,
            amount: parsed.amount,
            claimed: false,
            receivedAt: timestamp ? new Date(timestamp) : admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        const cfgSnap = await db.collection("config").doc("app").get();
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        const isAutoOn = cfg.autoDeposit !== false;

        if (!isAutoOn) {
            return res.json({ ok: true, matched: true, autoApproved: false, note: "Auto-deposit is OFF by Admin" });
        }

        const depQuery = await db.collection("deposits")
            .where("status", "==", "pending")
            .where("trxId", "==", cleanTrx)
            .limit(1)
            .get();

        if (!depQuery.empty) {
            const depDoc = depQuery.docs[0];
            const depData = depDoc.data();

            const now = Date.now();
            const depTime = depData.createdAt && depData.createdAt.toMillis ? depData.createdAt.toMillis() : now;
            const smsTime = timestamp || now;

            if (Math.abs(now - smsTime) > 5 * 60 * 1000 || Math.abs(now - depTime) > 5 * 60 * 1000) {
                await db.collection("deposits").doc(depDoc.id).update({
                    status: "rejected",
                    adminMsg: "❌ ৫ মিনিটের বেশি সময় পার হয়ে গেছে! সময়মতো সাবমিট করুন।"
                });
                return res.json({ ok: false, error: "EXPIRED: ৫ মিনিটের বেশি সময় পার হয়ে গেছে!" });
            }

            if (Number(depData.amount) === Number(parsed.amount)) {
                await approveDepositSafe(depDoc.id, depData, parsed.amount, cfg.coinRate || 7);
                return res.json({ ok: true, matched: true, autoApproved: true, depId: depDoc.id });
            } else {
                await db.collection("deposits").doc(depDoc.id).update({
                    status: "rejected",
                    adminMsg: `❌ টাকার পরিমাণ মিলেনি! আসল পেমেন্ট ছিল ${parsed.amount} BDT কিন্তু সাবমিট করেছেন ${depData.amount} BDT`
                });
            }
        }

        return res.json({ ok: true, matched: true, autoApproved: false, message: "Saved in database, awaiting user submission" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/gateway/verify-deposit", async (req, res) => {
    const { depId, trxId, amount } = req.body;
    if (!depId || !trxId) return res.status(400).json({ ok: false, error: "Missing data" });

    const cleanTrx = trxId.toUpperCase().trim();

    try {
        const cfgSnap = await db.collection("config").doc("app").get();
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        if (cfg.autoDeposit === false) {
            return res.json({ ok: true, autoApproved: false, note: "Manual Mode" });
        }

        const smsDoc = await db.collection("gateway_sms").doc(cleanTrx).get();
        if (!smsDoc.exists) {
            await db.collection("deposits").doc(depId).update({
                status: "rejected",
                adminMsg: "❌ এই TrxID দিয়ে কোনো টাকা আসেনি বা SMS পাওয়া যায়নি!"
            });
            return res.json({ ok: false, error: "কোনো পেমেন্ট পাওয়া যায়নি! সঠিক TrxID দিন।" });
        }

        const smsData = smsDoc.data();
        const smsTime = smsData.receivedAt && smsData.receivedAt.toMillis ? smsData.receivedAt.toMillis() : Date.now();
        const now = Date.now();

        if (now - smsTime > 5 * 60 * 1000) {
            await db.collection("deposits").doc(depId).update({
                status: "rejected",
                adminMsg: "❌ টাকা পাঠানোর ৫ মিনিটের মধ্যে সাবমিট করেননি!"
            });
            return res.json({ ok: false, error: "টাকা পাঠানোর ৫ মিনিট পার হয়ে গেছে! পুনরায় চেষ্টা করুন।" });
        }

        if (Number(smsData.amount) !== Number(amount)) {
            await db.collection("deposits").doc(depId).update({
                status: "rejected",
                adminMsg: `❌ টাকার পরিমাণ ভুল! আসল টাকা ছিল ${smsData.amount} BDT`
            });
            return res.json({ ok: false, error: `টাকার পরিমাণ মিলেনি! আসল পেমেন্ট ছিল ${smsData.amount} BDT` });
        }

        const depDoc = await db.collection("deposits").doc(depId).get();
        await approveDepositSafe(depId, depDoc.data(), smsData.amount, cfg.coinRate || 7);
        return res.json({ ok: true, message: "Approved successfully!" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- DAILY BONUS ----------------
let bonusCfgCache = { at: 0, enabled: true };
async function getBonusCfg() {
    try {
        if (Date.now() - bonusCfgCache.at < 60000) return bonusCfgCache;
        const c = await db.collection("config").doc("app").get();
        const d = c.exists ? (c.data() || {}) : {};
        bonusCfgCache = { at: Date.now(), enabled: d.bonusEnabled !== false };
    } catch (e) {}
    return bonusCfgCache;
}
function rollBonus() {
    const r = Math.random() * 100;
    if (r < 55) return 0.1;
    if (r < 80) return 0.2;
    if (r < 92) return 0.3;
    if (r < 98) return 0.4;
    return 0.5;
}
function dhakaDay(offsetDays) {
    try {
        const t = Date.now() + (offsetDays || 0) * 86400000;
        return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
    } catch (e) {
        return new Date(Date.now() + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
    }
}
app.post("/api/bonus/claim", async (req, res) => {
    try {
        const body = req.body || {};
        const uid = (body.uid || "").toString();
        if (!uid) return res.status(400).json({ ok: false, error: "Login required" });
        const cfg = await getBonusCfg();
        if (!cfg.enabled) return res.json({ ok: false, error: "Daily bonus ekhon bondho ache" });
        const today = dhakaDay(0), yest = dhakaDay(-1);
        const uref = db.collection("users").doc(uid);
        const out = await db.runTransaction(async (t) => {
            const s = await t.get(uref);
            if (!s.exists) throw new Error("nouser");
            const d = s.data() || {};
            if (d.lastBonusDay === today) throw new Error("claimed");
            const amt = rollBonus();
            const streak = (d.lastBonusDay === yest) ? (Number(d.lastBonusStreak) || 0) + 1 : 1;
            t.update(uref, {
                balance: Math.round(((Number(d.balance) || 0) + amt) * 10) / 10,
                lastBonusDay: today,
                lastBonusStreak: streak
            });
            t.set(db.collection("redemptions").doc(), {
                uid: uid,
                name: (body.name || d.name || "User").toString().slice(0, 60),
                email: (body.email || d.email || "").toString().slice(0, 120),
                code: "DAILY", amount: amt,
                note: "Daily bonus +" + amt + " - day " + streak,
                status: "approved",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                expiresAt: new Date(Date.now() + 10 * 86400000)
            });
            return { bonus: amt, streak: streak };
        });
        return res.json({ ok: true, bonus: out.bonus, streak: out.streak });
    } catch (e) {
        const m = (e && e.message) || "";
        if (m === "claimed") return res.json({ ok: false, error: "Ajker bonus neya hoyeche" });
        return res.json({ ok: false, error: "Bonus failed, abar try korun" });
    }
});
app.get("/api/bonus/status", async (req, res) => {
    try {
        const uid = ((req.query || {}).uid || "").toString();
        if (!uid) return res.status(400).json({ ok: false, error: "uid" });
        const cfg = await getBonusCfg();
        const s = await db.collection("users").doc(uid).get();
        const d = s.exists ? (s.data() || {}) : {};
        const isClaimed = d.lastBonusDay === dhakaDay(0);
        
        const nowServer = Date.now();
        const dhakaNextMidnight = new Date(new Date(nowServer).toLocaleString("en-US", { timeZone: "Asia/Dhaka" }));
        dhakaNextMidnight.setHours(24, 0, 0, 0);
        const msUntilNext = Math.max(0, dhakaNextMidnight.getTime() - new Date(new Date(nowServer).toLocaleString("en-US", { timeZone: "Asia/Dhaka" })).getTime());
        const serverNextClaimAt = nowServer + msUntilNext;

        return res.json({ 
            ok: true, 
            enabled: cfg.enabled, 
            claimed: isClaimed, 
            streak: Number(d.lastBonusStreak) || 0,
            serverNow: nowServer,
            nextClaimAt: isClaimed ? serverNextClaimAt : 0
        });
    } catch (e) { return res.json({ ok: false, error: "status failed" }); }
});

async function approveDepositById(depId, verifiedBy = "Admin_Telegram") {
    const depDoc = await db.collection("deposits").doc(depId).get();
    if (!depDoc.exists) throw new Error("Deposit document not found");
    const depData = depDoc.data();
    if (depData.status !== "pending") throw new Error("Deposit already processed (" + depData.status + ")");

    const cfgSnap = await db.collection("config").doc("app").get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};
    await approveDepositSafe(depId, depData, depData.amount, cfg.coinRate || 7);
    return depData;
}

async function rejectDepositById(depId) {
    const depDoc = await db.collection("deposits").doc(depId).get();
    if (!depDoc.exists) throw new Error("Deposit not found");
    await db.collection("deposits").doc(depId).update({
        status: "rejected",
        rejectedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return depDoc.data();
}

async function approveDepositSafe(depId, depData, verifiedAmount, coinRate) {
    const cleanTrx = depData.trxId.toUpperCase();
    await db.runTransaction(async (t) => {
        const usedRef = db.collection("used_trx").doc(cleanTrx);
        const usedSnap = await t.get(usedRef);
        if (usedSnap.exists) throw new Error("TRX_ALREADY_USED");

        const depRef = db.collection("deposits").doc(depId);
        const ds = await t.get(depRef);
        if (!ds.exists || ds.data().status !== "pending") throw new Error("DEP_INVALID");

        const rate = Number(coinRate || 7);
        const coinsToAdd = Number(depData.coins) || Math.floor(Number(verifiedAmount) / rate) || 3;

        const userRef = db.collection("users").doc(depData.uid);
        const userSnap = await t.get(userRef);

        if (!userSnap.exists) {
            t.set(userRef, {
                uid: depData.uid,
                name: depData.name || "User",
                email: depData.email || "",
                photo: "",
                balance: coinsToAdd,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } else {
            t.update(userRef, { balance: (Number(userSnap.data().balance) || 0) + coinsToAdd });
        }

        let durationSec = 2;
        if (depData.createdAt && depData.createdAt.toMillis) {
            durationSec = Math.max(1, Math.round((Date.now() - depData.createdAt.toMillis()) / 1000));
        }

        t.update(depRef, {
            status: "approved",
            autoApproved: true,
            submittedAt: depData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
            smsReceivedAt: depData.smsReceivedAt || admin.firestore.FieldValue.serverTimestamp(),
            approvedAt: admin.firestore.FieldValue.serverTimestamp(),
            processDurationSec: durationSec
        });

        t.set(usedRef, {
            trxId: cleanTrx,
            uid: depData.uid,
            amount: verifiedAmount,
            depId: depId,
            usedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const smsRef = db.collection("gateway_sms").doc(cleanTrx);
        t.set(smsRef, {
            claimed: true,
            claimedBy: depData.uid,
            claimedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    });

    try {
        const uSnap = await db.collection("users").doc(depData.uid).get();
        const tgChat = uSnap.exists ? uSnap.data().tgChatId : null;
        if (tgChat) {
            await notifyUserTelegram(tgChat,
                `✅ <b>ডিপোজিট সফলভাবে অ্যাপ্রুভ হয়েছে!</b>\n\n` +
                `💳 <b>মেথড:</b> ${depData.method}\n` +
                `💵 <b>টাকা:</b> ${verifiedAmount} BDT\n` +
                `🪙 <b>প্রাপ্ত কয়েন:</b> ${Number(depData.coins) || 3} Coins\n` +
                `🔖 <b>TrxID:</b> <code>${cleanTrx}</code>\n\n` +
                `আপনার ব্যালেন্স স্বয়ংক্রিয়ভাবে যোগ করা হয়েছে! 🚀`
            );
        }
    } catch (e) {}
}

// ---------------- 2. FIREBASE ADMIN ----------------
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
    serviceAccount = require("./serviceAccountKey.json");
}
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ---------------- 3. CONFIGURATIONS (Updated to Your New API ID & HASH) ----------------
const DEFAULT_API_ID = Number(process.env.TELEGRAM_API_ID || 39447470);
const DEFAULT_API_HASH = process.env.TELEGRAM_API_HASH || "eb7cac1c8ad9935d4b208dc0da076d8c";
const TARGET_BOT = process.env.TARGET_BOT || "PlayQuestHelperBot";

const USER_NOTIFY_BOT_TOKEN = process.env.USER_NOTIFY_BOT_TOKEN || "8906230491:AAEu4CX0T9Dz6YMLxeCNz6U-nbiQmiBiJ_s";
const ORDER_LOG_CHANNEL = process.env.ORDER_LOG_CHANNEL || "@ppmododderlog";

const userNotifyBot = new TelegramBot(USER_NOTIFY_BOT_TOKEN, { polling: true });

const PRIME_AUTO_REPLY_IMG = "https://pub-4c6b2dbf3a0c4862a8964b1546de6283.r2.dev/1791345238749_file_000000003d348211a5a894b5cf98d67c.png";
const PRIME_AUTO_REPLY_CAPTION = `👋 <b>হ্যালো!</b>\n\nএডমিন অনলাইনে আসলে আপনার মেসেজের রিপ্লাই দেওয়া হবে। আপনার কী প্রয়োজন তা নিচে লিখে রাখুন।\n\n⚡ <b>Auto Quest Complete মাত্র ৩ সেকেন্ডে:</b>\n👉 <a href="https://t.me/Ppmod_bot">@Ppmod_bot</a>\n\n📢 <b>অফিসিয়াল চ্যানেল:</b> <a href="https://t.me/googleplaypointhack">@googleplaypointhack</a>\n\nধন্যবাদ! ✨`;

let currentClient = null;
let currentPhone = null;
let primeClient = null;
let primePhone = null;

const activeOrders = new Set();
const autoReplyCooldown = new Map();
const pendingAuthClients = new Map();

// 🟢 FIXED PHONE NUMBER FORMATTER (No +880017... bug)
function formatBdPhone(raw) {
    let num = (raw || "").toString().replace(/[^0-9]/g, "");
    if (num.startsWith("880")) {
        return "+" + num;
    }
    if (num.startsWith("0")) {
        // Remove leading 0 and attach +880 (e.g. 01712... -> +8801712...)
        return "+880" + num.substring(1);
    }
    if (num.startsWith("1") && num.length === 10) {
        return "+880" + num;
    }
    return "+" + num;
}

// ---------------- 7. FAST DIRECT OTP API ----------------
app.post("/api/tg/send-otp", async (req, res) => {
    const rawInput = req.body.phone || "";
    const phone = formatBdPhone(rawInput);

    console.log(`[TG LOGIN] Requesting OTP for phone: ${phone} (Raw: ${rawInput}) using API_ID: ${DEFAULT_API_ID}`);

    if (!phone || phone.length < 13) {
        return res.status(400).json({ ok: false, error: "সঠিক ফোন নম্বর দিন (যেমন: 017XXXXXXXX)" });
    }

    try {
        const tempClient = new TelegramClient(new StringSession(""), DEFAULT_API_ID, DEFAULT_API_HASH, { 
            connectionRetries: 5,
            useWSS: false 
        });

        await tempClient.connect();
        const result = await tempClient.sendCode({ 
            apiId: DEFAULT_API_ID, 
            apiHash: DEFAULT_API_HASH 
        }, phone);

        pendingAuthClients.set(phone, { client: tempClient, phoneCodeHash: result.phoneCodeHash });
        console.log(`[TG LOGIN] OTP Sent Successfully to: ${phone}`);
        return res.json({ ok: true, message: "OTP sent!", phone });
    } catch (err) {
        console.error(`[TG LOGIN ERR] Error sending OTP to ${phone}:`, err);
        return res.status(500).json({ 
            ok: false, 
            error: err.errorMessage || err.message || "Failed to send code via Telegram" 
        });
    }
});

// Universal 2FA SRP Calculator Helper
async function computeSrpHash(client, password) {
    if (typeof client.checkPassword === "function") {
        return await client.checkPassword(password);
    }

    let computeFn = null;
    const candidates = [
        () => require("telegram/Password").computeCheckPassword,
        () => require("telegram/Password"),
        () => require("telegram/Password.js").computeCheckPassword,
        () => require("telegram/Password.js"),
        () => require("telegram").computeCheckPassword,
        () => require("telegram").Password?.computeCheckPassword,
        () => require("telegram/Utils")?.computeCheckPassword
    ];

    for (const cand of candidates) {
        try {
            const fn = cand();
            if (typeof fn === "function") { computeFn = fn; break; }
            if (fn && typeof fn.default === "function") { computeFn = fn.default; break; }
            if (fn && typeof fn.computeCheckPassword === "function") { computeFn = fn.computeCheckPassword; break; }
        } catch (e) {}
    }

    const srpResult = await client.invoke(new Api.account.GetPassword());
    if (computeFn) {
        return await computeFn(srpResult, password);
    }
    throw new Error("2FA Password module resolution failed");
}

app.post("/api/tg/verify-otp", async (req, res) => {
    const phone = formatBdPhone(req.body.phone || "");
    const code = (req.body.code || "").toString().trim();
    const password = (req.body.password || "").toString().trim();

    const item = pendingAuthClients.get(phone);
    if (!item) return res.status(400).json({ ok: false, error: "সেশন মেয়াদ শেষ! আবার OTP পাঠান।" });

    try {
        try {
            await item.client.invoke(new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: item.phoneCodeHash,
                phoneCode: code
            }));
        } catch (signInErr) {
            if (signInErr.errorMessage === "SESSION_PASSWORD_NEEDED" || (signInErr.message && (signInErr.message.includes("2FA") || signInErr.message.includes("PASSWORD")))) {
                if (!password) return res.status(400).json({ ok: false, error: "Two-Step পাসওয়ার্ড দিন" });

                if (typeof item.client.checkPassword === "function") {
                    await item.client.checkPassword(password);
                } else {
                    const passwordSrpHash = await computeSrpHash(item.client, password);
                    await item.client.invoke(new Api.auth.CheckPassword({ password: passwordSrpHash }));
                }
            } else {
                throw signInErr;
            }
        }

        const sessionString = item.client.session.save();
        await db.collection("tg_accounts").doc(phone).set({
            phone, session: sessionString, balance: 0, active: true, addedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        pendingAuthClients.delete(phone);
        return res.json({ ok: true, message: "Account connected successfully!" });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.errorMessage || err.message });
    }
});

// ---------------- 8. REAL BALANCE AUDIT API ----------------
app.post("/api/tg/check-balance", async (req, res) => {
    try {
        const snap = await db.collection("tg_accounts").get();
        if (snap.empty) return res.json({ ok: false, error: "কোনো অ্যাকাউন্ট পুলে নেই" });

        let totalBalance = 0;
        const results = [];

        for (const docSnap of snap.docs) {
            const acc = docSnap.data();
            const phone = acc.phone || docSnap.id;
            if (!acc.session) continue;

            try {
                const tempClient = new TelegramClient(new StringSession(acc.session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
                await tempClient.connect();
                await tempClient.sendMessage(TARGET_BOT, { message: "🚀 Start Process" });
                await new Promise((r) => setTimeout(r, 2500));

                const msgs = await tempClient.getMessages(TARGET_BOT, { limit: 1 });
                let b = null;
                if (msgs && msgs.length > 0) b = parseBotBalance(msgs[0].message);

                if (b !== null) {
                    await db.collection("tg_accounts").doc(docSnap.id).update({
                        balance: b, lastCheckedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    totalBalance += b;
                    results.push({ phone, balance: b });
                } else {
                    results.push({ phone, balance: acc.balance || 0 });
                }
                await tempClient.disconnect();
            } catch (err) {
                results.push({ phone, balance: acc.balance || 0 });
            }
        }

        await db.collection("config").doc("app").set({
            botTokensTotal: totalBalance, botTokensLastSync: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.json({ ok: true, total: totalBalance, accounts: results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

function parseBotBalance(text) {
    if (!text) return null;
    const match = text.match(/(?:balance|new balance|current balance)\s*[:\-]?\s*(\d+)/i) 
               || text.match(/(\d+)\s*(?:tokens|token|🪙)/i);
    return match ? Number(match[1]) : null;
}

// ---------------- 13. MASTER WORKER START ----------------
async function startMasterWorker() {
    console.log("[MASTER INIT] Starting PP MOD Master Worker...");
    console.log(`[CONFIG] Using API_ID: ${DEFAULT_API_ID}`);
    console.log("[MASTER INIT] Active!");
}

startMasterWorker().catch(console.error);