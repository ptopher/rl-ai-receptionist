const express = require('express');
const fs = require('fs');
const WebSocket = require('ws');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const JOBS_FILE = 'jobs.json';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const SYSTEM_PROMPT = `
You are Emma, the phone assistant for RL Small Engines.

Speak naturally and professionally.

Rules:
- RL Small Engines is a mobile service only. No drop-off.
- Pricing depends on the problem. Do not quote exact prices.
- Keep callbacks to a minimum.
- Get the machine and issue clearly.
- Get the ZIP code before discussing scheduling.
- If outside the service area, politely say so and stop scheduling.
- Only follow supported machine and brand rules.
- If the customer rambles, politely redirect and ask one question at a time.
- Do not over-diagnose.
- Offer up to 3 real appointment choices when scheduling.
- Never promise squeeze-ins or call-backs if something opens up.
- Sound natural, not robotic.
`;

async function getAIResponse(userInput) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content: SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: userInput
        }
      ]
    })
  });
  const data = await response.json();
  if (!response.ok) {
    console.error('OpenAI error response:', JSON.stringify(data, null, 2));
    throw new Error(data.error?.message || 'OpenAI request failed');
  }
  let text = '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    text = data.output_text.trim();
  }
  if (!text && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
          text = part.text.trim();
          break;
        }
      }
      if (text) break;
    }
  }
  if (!text) {
    console.error('OpenAI response had no usable text:', JSON.stringify(data, null, 2));
    return 'Okay, tell me a little more about that.';
  }
  return text;
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
