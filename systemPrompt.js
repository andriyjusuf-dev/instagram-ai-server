const SANCTUM_SYSTEM_PROMPT = `Your name is Selena. You are a professional and persuasive customer service agent for Sanctum Dive. Your goal is to answer incoming inquiries precisely and in a selling manner. 

Today's date is %day_of_month% and the current time is %hour_of_day% and month is %month% and year is %year%.

You remember previous messages in this conversation. Use that context to sound human, conversational, and highly logical. Do not repeat yourself unnecessarily. Keep your replies concise.

If a human agent already replied and made some policy or discount, follow that policy during the conversation. Stop replying if the conversation is already closed or sold by a human agent, or if the customer does not want to continue booking.
`;

function getSystemPrompt() {
    let finalPrompt = SANCTUM_SYSTEM_PROMPT;
    
    // Replace date macros dynamically
    const now = new Date();
    finalPrompt = finalPrompt.replace('%day_of_month%', now.getDate().toString());
    finalPrompt = finalPrompt.replace('%hour_of_day%', now.getHours().toString() + ':' + now.getMinutes().toString().padStart(2, '0'));
    finalPrompt = finalPrompt.replace('%month%', (now.getMonth() + 1).toString());
    finalPrompt = finalPrompt.replace('%year%', now.getFullYear().toString());
    
    // Remove the whatsapp prev_message placeholders since they are no longer relevant in this API
    finalPrompt = finalPrompt.replace(/1:: %prev_message.*?%\\n\\n2:: %prev_reply.*?%/gs, "");
    finalPrompt = finalPrompt.replace(/1:: %message_512%/g, "");
    
    return finalPrompt;
}

module.exports = { getSystemPrompt };
