require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const mammoth = require('mammoth');
const xlsx = require('xlsx');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configuration
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_IG_USER_ID = process.env.META_IG_USER_ID;
const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || "").split(',');

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// In-memory cache to prevent duplicate processing or to track state
const memoryCache = new Map();
function cacheSet(key, value, ttlSeconds = 15) {
    memoryCache.set(key, value);
    setTimeout(() => memoryCache.delete(key), ttlSeconds * 1000);
}
function cacheGet(key) { return memoryCache.get(key); }
function cacheDelete(key) { memoryCache.delete(key); }

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 1. WEBHOOK VERIFICATION (GET)
// ==========================================
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === META_VERIFY_TOKEN) {
        return res.status(200).send(req.query['hub.challenge']);
    }
    return res.status(403).send("Forbidden");
});

// ==========================================
// 2. INCOMING MESSAGES & COMMENTS (POST)
// ==========================================
app.post('/webhook', (req, res) => {
    // ALWAYS return 200 OK immediately to decouple and prevent Meta timeout
    res.status(200).send({ status: "success" });
    
    // Process async
    processWebhook(req.body).catch(console.error);
});

async function processWebhook(data) {
    if (data.object !== 'instagram') return;
    
    const entry = data.entry[0];
    
    // Handle DMs and Story Mentions (Messaging)
    if (entry.messaging) {
        for (let i = 0; i < entry.messaging.length; i++) {
            const messagingEvent = entry.messaging[i];
            await handleMessagingEvent(messagingEvent);
        }
    }
    
    // Handle Comments (Changes)
    if (entry.changes) {
        for (let i = 0; i < entry.changes.length; i++) {
            const change = entry.changes[i];
            if (change.field === 'comments') {
                await handleCommentEvent(change.value);
            }
        }
    }
}

async function handleMessagingEvent(messagingEvent) {
    const senderId = messagingEvent.sender.id;
    const recipientId = messagingEvent.recipient.id;
    
    if (messagingEvent.message) {
        const messageObj = messagingEvent.message;
        
        // 1. Check for Human Takeover (Echo)
        if (messageObj.is_echo) {
            // Human is typing from the app
            const aiSent = cacheGet(`ai_sent_${recipientId}`); // If AI sent it, recipientId is the customer
            
            if (!aiSent) {
                const contextToSave = messageObj.text || "[Human sent media/attachment]";
                await pauseAI(recipientId, contextToSave);
            }
            return;
        }

        // 2. Customer or Admin is typing
        const textBody = messageObj.text || "";
        
        // Admin commands
        if (ADMIN_NUMBERS.includes(senderId) && (textBody.toLowerCase().startsWith('!learn') || textBody.toLowerCase().startsWith('!rule'))) {
            await handleAdminCommand(senderId, textBody);
            return;
        }

        const isPaused = await checkIsPaused(senderId);
        let contextToSave = textBody;

        // Check for Story Mention
        if (messageObj.story && messageObj.story.mention) {
            contextToSave = "[User mentioned us in a story] " + textBody;
            if (!isPaused) {
                console.log(`[Story Mention] from ${senderId}`);
                await appendHistory(senderId, "user", contextToSave);
                const geminiReply = await callGemini(senderId, "story_mention");
                if (geminiReply) {
                    await sleep(3000); // Small delay
                    await sendInstagramDM(senderId, geminiReply);
                }
                return;
            }
        }
        
        // Check for Attachments (Images, etc.)
        if (messageObj.attachments && messageObj.attachments.length > 0) {
            const attachment = messageObj.attachments[0];
            if (attachment.type === 'image') {
                const imageUrl = attachment.payload.url;
                const mediaData = await downloadMedia(imageUrl);
                if (mediaData) {
                    const description = await analyzeMedia(mediaData.buffer, mediaData.mimeType, textBody, "image");
                    contextToSave = `[Customer sent an image: ${description}]`;
                } else {
                    contextToSave = `[Customer sent an image, but it could not be downloaded] ${textBody}`;
                }
            } else {
                contextToSave = `[Customer sent an attachment of type: ${attachment.type}] ${textBody}`;
            }
        }

        if (isPaused) {
            await appendHistory(senderId, "user", contextToSave);
        } else {
            await appendHistory(senderId, "user", contextToSave);
            const geminiReply = await callGemini(senderId, "dm");
            if (geminiReply) {
                // Realistic typing delay
                const delayMs = Math.min(2000 + (geminiReply.length * 30), 12000);
                await sleep(delayMs);
                await sendInstagramDM(senderId, geminiReply);
            }
        }
    }
}

async function handleCommentEvent(commentValue) {
    const commentId = commentValue.id;
    const fromId = commentValue.from.id;
    const text = commentValue.text;

    // Ignore our own comments
    if (fromId === META_IG_USER_ID) return;
    
    // Ignore hidden or deleted comments
    if (commentValue.hidden || commentValue.deleted) return;

    console.log(`[New Comment] from ${fromId}: ${text}`);

    // Generate a positive reply specifically for this comment
    const geminiReply = await generateCommentReply(text);
    if (geminiReply) {
        await sleep(4000); // wait a bit before replying
        await replyToInstagramComment(commentId, geminiReply);
    }
}

// ==========================================
// 3. DATABASE MEMORY LOGIC
// ==========================================
async function getHistory(igUserId) {
    const { data, error } = await supabase
        .from('conversations')
        .select('role, message_text')
        .eq('ig_user_id', igUserId)
        .order('created_at', { ascending: false })
        .limit(20);
        
    if (error) {
        console.error("Supabase Error (getHistory):", error);
        return [];
    }
    
    return data.reverse().map(row => ({
        role: row.role,
        parts: [{ text: row.message_text }]
    }));
}

async function appendHistory(igUserId, role, text) {
    await supabase.from('conversations').insert([
        { ig_user_id: igUserId, role: role, message_text: text }
    ]);
}

async function checkIsPaused(igUserId) {
    const { data } = await supabase
        .from('pause_state')
        .select('paused_until')
        .eq('ig_user_id', igUserId)
        .single();
        
    if (data && data.paused_until) {
        const pausedUntil = new Date(data.paused_until);
        if (pausedUntil > new Date()) {
            return true;
        }
    }
    return false;
}

async function pauseAI(igUserId, humanMessage) {
    const pausedUntil = new Date();
    pausedUntil.setHours(pausedUntil.getHours() + 1);
    
    await supabase.from('pause_state').upsert({
        ig_user_id: igUserId,
        paused_until: pausedUntil.toISOString()
    });
    
    await appendHistory(igUserId, "model", humanMessage);
    console.log(`[Auto-Pause] Paused AI for ${igUserId}. Saved human context.`);
}

async function handleAdminCommand(adminId, commandText) {
    const rule = commandText.replace(/^!(learn|rule)\s*/i, '');
    await supabase.from('rules').insert([{ rule_text: rule }]);
    await sendInstagramDM(adminId, `✅ Rule successfully added to my brain:\n"${rule}"`);
    console.log(`[Admin Command] Added rule: ${rule}`);
}

async function buildSystemPrompt(type = "dm") {
    const { data } = await supabase
        .from('rules')
        .select('rule_text')
        .order('created_at', { ascending: true });
        
    let basePrompt = `You are a helpful, friendly customer service agent managing an Instagram account.\n`;
    
    if (type === "story_mention") {
        basePrompt += `The user has just mentioned you in their Instagram story. Reply warmly, thank them for the mention, and be enthusiastic. Keep it concise.\n`;
    } else {
        basePrompt += `IMPORTANT: Use minimal, relevant, and nice emoticons. Do not overuse them. Keep your replies concise, friendly, and conversational. Do NOT send massive walls of text unless absolutely necessary.\n\n`;
    }
    
    if (data && data.length > 0) {
        basePrompt += "--- GUIDEBOOK & RULES ---\n";
        data.forEach((r, idx) => {
            basePrompt += `${idx + 1}. ${r.rule_text}\n`;
        });
        basePrompt += "-------------------------\n";
    }
    
    return basePrompt;
}

// ==========================================
// 4. GEMINI API LOGIC
// ==========================================
async function callGemini(igUserId, type = "dm") {
    const history = await getHistory(igUserId);
    const systemPrompt = await buildSystemPrompt(type);
    
    const payload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: history
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );
        
        if (response.data.candidates && response.data.candidates.length > 0) {
            const botReply = response.data.candidates[0].content.parts[0].text;
            await appendHistory(igUserId, "model", botReply);
            return botReply;
        }
    } catch (error) {
        console.error("Gemini Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
    return null;
}

async function generateCommentReply(commentText) {
    const systemPrompt = `You are the friendly owner of an Instagram page. A user just commented on your post.
Generate a short, positive, and appreciative reply to their comment. Keep it under 2 sentences, use nice emojis. If their comment is negative or toxic, reply with a calm, polite message or a simple acknowledgment.`;
    
    const payload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: `User's Comment: "${commentText}"` }] }]
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );
        
        if (response.data.candidates && response.data.candidates.length > 0) {
            return response.data.candidates[0].content.parts[0].text;
        }
    } catch (error) {
        console.error("Gemini Comment Reply Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
    return null;
}

// ==========================================
// 5. META INSTAGRAM API & MEDIA
// ==========================================
async function downloadMedia(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');
        const mimeType = response.headers['content-type'];
        return { buffer, mimeType };
    } catch (error) {
        console.error("Media Download Error:", error.message);
        return null;
    }
}

async function analyzeMedia(buffer, mimeType, caption, mediaType) {
    let prompt = `Please describe this image in detail. The customer sent this in a DM. ${caption ? `Caption: "${caption}"` : ''}`;

    const payload = {
        contents: [{
            parts: [
                { text: prompt },
                { inlineData: { mimeType: mimeType, data: buffer.toString('base64') } }
            ]
        }]
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );
        if (response.data.candidates && response.data.candidates.length > 0) {
            return response.data.candidates[0].content.parts[0].text;
        }
    } catch (error) {
        console.error("Gemini Media Analysis Error:", error.response ? JSON.stringify(error.response.data) : error.message);
        return `[Could not analyze image.]`;
    }
    return "Media could not be analyzed.";
}

async function sendInstagramDM(recipientId, textMessage) {
    const url = `https://graph.facebook.com/v21.0/me/messages`;
    
    const payload = {
        recipient: { id: recipientId },
        message: { text: textMessage }
    };

    try {
        cacheSet(`ai_sent_${recipientId}`, "true", 15);
        await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` }
        });
        console.log(`[Sent] DM to ${recipientId}`);
    } catch (error) {
        console.error("Instagram DM Send Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

async function replyToInstagramComment(commentId, replyText) {
    const url = `https://graph.facebook.com/v21.0/${commentId}/replies`;
    
    const payload = { message: replyText };

    try {
        await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` }
        });
        console.log(`[Sent] Reply to comment ${commentId}`);
    } catch (error) {
        console.error("Instagram Comment Reply Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

app.listen(PORT, () => {
    console.log(`Instagram AI Server is running on port ${PORT}`);
});
