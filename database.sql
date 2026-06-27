-- Enable the uuid-ossp extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Conversations Table (Memory)
CREATE TABLE public.conversations (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    ig_user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'model')),
    message_text TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Rules Table (System Prompts)
CREATE TABLE public.rules (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    rule_text TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Pause State Table (Human Takeover)
CREATE TABLE public.pause_state (
    ig_user_id TEXT PRIMARY KEY,
    paused_until TIMESTAMP WITH TIME ZONE
);
