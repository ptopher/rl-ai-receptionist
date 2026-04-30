const express = require('express');
const fs = require('fs');
const WebSocket = require('ws');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const app = express();

const config = require('./config');

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const JOBS_FILE = 'jobs.json';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const SYSTEM_PROMPT = config.systemPrompt;

function parseGPTResponseText(data) {
  return (data.output && data.output[0] && data.output[0].content && data.output[0].content[0] && data.output[0].content[0].text) || data.output_text || '';
}

function buildStateContext(callState) {
  const lines = [];
  lines.push(`Machine: ${callState.machine || 'not yet known'}`);
  lines.push(`Issue: ${callState.issue || 'not yet known'}`);
  lines.push(`ZIP: ${callState.zipConfirmed ? callState.zip + ' (confirmed)' : callState.zip ? callState.zip + ' (unconfirmed)' : 'not yet known'}`);
  lines.push(`Serviceable area: ${callState.serviceable ? 'yes' : 'not confirmed'}`);
  lines.push(`Scheduling: ${callState.inScheduling ? 'yes' : 'not started'}`);
  if (callState.selectedSlot) {
    lines.push(`Appointment slot: ${callState.selectedSlot.readableDate} ${callState.selectedSlot.serviceWindow}`);
  }
  lines.push(`Caller name: ${callState.callerName || 'not yet collected'}`);
  lines.push(`Phone: ${callState.phone ? 'collected' : 'not yet collected'}`);
  lines.push(`Address: ${callState.address ? 'collected' : 'not yet collected'}`);
  lines.push(`Email: ${callState.email ? 'collected' : 'not yet collected'}`);
  return lines.join('\n');
}

async function getEmmaReply(callState, callerSaid, instruction, fallback) {
  const stateContext = buildStateContext(callState);
  const systemContent = `${SYSTEM_PROMPT}

CURRENT CALL STATE:
${stateContext}

INSTRUCTION: ${instruction}

RULES:
- One sentence only. Natural, conversational, not robotic.
- Do not ask for information already collected (see call state above).
- Do not mention brand, model, or pricing unless the caller asked.
- Never say "I understand" or "I see" or "Certainly" — just respond naturally.
- This is a phone call — keep it brief and clear.`;

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: [
          { role: 'system', content: systemContent },
          { role: 'user', content: callerSaid || '' }
        ]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'OpenAI error');
    const text = parseGPTResponseText(data).trim();
    return text || fallback;
  } catch (err) {
    console.error('getEmmaReply error:', err);
    return fallback;
  }
}


// ===== HOME / ROUTING SETTINGS =====
const routingConfig = config.routingConfig;

// ===== EMAIL SETTINGS (Resend) =====
const RESEND_API_KEY = config.resendApiKey;
const RESEND_FROM = config.resendFrom;

async function sendAppointmentConfirmationEmail({
  to,
  name,
  machine,
  issue,
  serviceDate,
  serviceWindow,
  address
}) {
  const readableDate = getReadableDate(serviceDate);

  const htmlBody = config.buildConfirmationEmailHtml({
    name,
    machine,
    issue,
    readableDate,
    serviceWindow,
    address,
    xmlEscape
  });

  console.log('Attempting Resend email to:', to);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: config.buildConfirmationEmailSubject(readableDate),
      html: htmlBody
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Resend error:', data);
    throw new Error(data.message || 'Resend API error');
  }

  console.log('Resend email sent successfully, id:', data.id);
  return { sent: true, id: data.id };
}

// ===== COUNTY ZIP MAPS =====
const countyZips = config.countyZips;

// ===== LOCAL CORRECTION LAYER =====
const exactPhraseCorrections = config.exactPhraseCorrections;

const wordCorrections = config.wordCorrections;

// ===== HELPERS =====
function cleanText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s@.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function say(text) {
  return `<Say voice="alice">${xmlEscape(text)}</Say>`;
}

function pause(seconds = 1) {
  return `<Pause length="${seconds}"/>`;
}

function digitsToWords(value) {
  const map = {
    '0': 'zero',
    '1': 'one',
    '2': 'two',
    '3': 'three',
    '4': 'four',
    '5': 'five',
    '6': 'six',
    '7': 'seven',
    '8': 'eight',
    '9': 'nine'
  };

  return String(value || '')
    .replace(/\D/g, '')
    .split('')
    .map((d) => map[d] || d)
    .join(', ');
}

function formatAddressForSpeech(address) {
  return String(address || '').replace(/\d[\d-]*/g, (match) => digitsToWords(match));
}

function replaceAllWholePhrase(text, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), to);
}

function applyLocalCorrections(text) {
  let corrected = String(text || '');

  for (const [from, to] of exactPhraseCorrections) {
    corrected = replaceAllWholePhrase(corrected, from, to);
  }

  const parts = corrected.split(/(\s+)/);
  corrected = parts
    .map((part) => {
      const lower = part.toLowerCase();
      return wordCorrections[lower] || part;
    })
    .join('');

  corrected = corrected.replace(/\s+/g, ' ').trim();
  return corrected;
}

function normalizeStreetSuffixWord(word) {
  const lower = word.toLowerCase();

  const streetMap = {
    st: 'St',
    street: 'Street',
    rd: 'Rd',
    road: 'Road',
    ave: 'Ave',
    avenue: 'Avenue',
    blvd: 'Blvd',
    boulevard: 'Boulevard',
    dr: 'Dr',
    drive: 'Drive',
    ct: 'Court',
    court: 'Court',
    ln: 'Ln',
    lane: 'Lane',
    pl: 'Pl',
    place: 'Place',
    cir: 'Cir',
    circle: 'Circle',
    ter: 'Ter',
    terrace: 'Terrace',
    pkwy: 'Pkwy',
    parkway: 'Pkwy'
  };

  return streetMap[lower] || null;
}

function normalizeAddressText(address) {
  let corrected = applyLocalCorrections(address);

  corrected = corrected
    .replace(/[?!"""]/g, ' ')
    .replace(/[;:]/g, ' ')
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s*\.\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  corrected = corrected
    .replace(/\b7\s+Maryland\b/gi, 'Severn Maryland')
    .replace(/\bStubborn\s+Maryland\b/gi, 'Severn Maryland')
    .replace(/\bStubbern\s+Maryland\b/gi, 'Severn Maryland');

  const tokens = corrected.split(/\s+/);
  const rebuilt = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const rawToken = tokens[i];
    const token = rawToken.replace(/[,.]/g, '');

    if (!token) continue;

    if (/^\d[\d-]*$/.test(token)) {
      rebuilt.push(token);
      continue;
    }

    const suffix = normalizeStreetSuffixWord(token);
    if (suffix) {
      rebuilt.push(suffix);
      continue;
    }

    const normalizedWord = token
      .split('-')
      .map((piece) => {
        if (!piece) return piece;
        return piece.charAt(0).toUpperCase() + piece.slice(1).toLowerCase();
      })
      .join('-');

    rebuilt.push(normalizedWord);
  }

  return rebuilt.join(' ').replace(/\s{2,}/g, ' ').trim();
}

function removeTrailingZipOnly(text, zip) {
  if (!zip) return String(text || '').trim();
  const escapedZip = zip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text || '')
    .replace(new RegExp(`\\s+${escapedZip}\\s*$`, 'i'), '')
    .trim();
}

function removeKnownLocationSuffix(text, place, zip) {
  let result = String(text || '').trim();
  if (!result) return result;

  const city = String(place?.city || '').trim();
  const state = String(place?.state || '').trim();
  const stateAbbreviation = String(place?.stateAbbreviation || '').trim();

  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [];

  if (city && state && zip) {
    patterns.push(new RegExp(`\\s+${escapeRegex(city)}\\s+${escapeRegex(state)}\\s+${escapeRegex(zip)}\\s*$`, 'i'));
  }

  if (city && stateAbbreviation && zip) {
    patterns.push(new RegExp(`\\s+${escapeRegex(city)}\\s+${escapeRegex(stateAbbreviation)}\\s+${escapeRegex(zip)}\\s*$`, 'i'));
  }

  if (city && state) {
    patterns.push(new RegExp(`\\s+${escapeRegex(city)}\\s+${escapeRegex(state)}\\s*$`, 'i'));
  }

  if (city && stateAbbreviation) {
    patterns.push(new RegExp(`\\s+${escapeRegex(city)}\\s+${escapeRegex(stateAbbreviation)}\\s*$`, 'i'));
  }

  if (state && zip) {
    patterns.push(new RegExp(`\\s+${escapeRegex(state)}\\s+${escapeRegex(zip)}\\s*$`, 'i'));
  }

  if (stateAbbreviation && zip) {
    patterns.push(new RegExp(`\\s+${escapeRegex(stateAbbreviation)}\\s+${escapeRegex(zip)}\\s*$`, 'i'));
  }

  if (zip) {
    patterns.push(new RegExp(`\\s+${escapeRegex(zip)}\\s*$`, 'i'));
  }

  for (const pattern of patterns) {
    if (pattern.test(result)) {
      result = result.replace(pattern, '').trim();
      break;
    }
  }

  return result;
}

function normalizeIssueText(text) {
  return applyLocalCorrections(String(text || 'Unknown')).trim() || 'Unknown';
}

function normalizeNameText(name) {
  const corrected = applyLocalCorrections(name);
  return corrected
    .split(/\s+/)
    .map((word) => {
      if (!word) return word;
      return word.replace(/[.,;:!?]+$/, '').charAt(0).toUpperCase() + word.replace(/[.,;:!?]+$/, '').slice(1).toLowerCase();
    })
    .filter(Boolean)
    .join(' ')
    .trim();
}

function normalizeCityText(city) {
  return applyLocalCorrections(String(city || ''))
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\b(city|town|maryland|md)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCityFromLocationText(text, zip = '') {
  let value = applyLocalCorrections(String(text || ''));

  if (zip) {
    const escapedZip = String(zip).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp(`\\b${escapedZip}\\b`, 'g'), ' ');
  }

  value = value
    .replace(/\b(my zip is|zip code is|zip is|zipcode is|i am in|i'm in|in zip|zip code|zipcode|zip|city is|city)\b/gi, ' ')
    .replace(/\d/g, ' ')
    .replace(/[^a-zA-Z\s-]/g, ' ')
    .replace(/\b(maryland|md)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalizeCityText(value);
}

async function validateZipAndCity(zip, city) {
  if (!zip || !city) {
    return { ok: false, reason: 'missing' };
  }

  const place = await getZipPlaceInfo(zip);
  if (!place || !place.city) {
    return { ok: false, reason: 'unknown_zip' };
  }

  const spokenCity = normalizeCityText(city);
  const expectedCity = normalizeCityText(place.city);

  if (!spokenCity || !expectedCity) {
    return { ok: false, reason: 'missing' };
  }

  const matches =
    spokenCity === expectedCity ||
    spokenCity.includes(expectedCity) ||
    expectedCity.includes(spokenCity);

  return {
    ok: matches,
    spokenCity,
    expectedCity,
    place
  };
}

async function extractValidatedZipCityFromSpeech(text) {
  const raw = String(text || '').trim();
  const zip = normalizeSpokenDigits(raw).slice(0, 5);
  const city = extractCityFromLocationText(raw, zip);

  if (!zip || !city) {
    return { ok: false, zip, city, reason: 'missing' };
  }

  const validation = await validateZipAndCity(zip, city);
  if (!validation.ok) {
    return { ok: false, zip, city, reason: validation.reason, expectedCity: validation.expectedCity || '' };
  }

  return {
    ok: true,
    zip,
    city: validation.expectedCity,
    place: validation.place
  };
}

function normalizeEmailSpeech(text) {
  let email = String(text || '').trim().toLowerCase();

  email = email.replace(/[,"']/g, ' ');
  email = email.replace(/\b(my email is|email is|email address is|my email address is|it is|it's|its)\b/g, ' ');
  email = email.replace(/\bplease send it to\b/g, ' ');
  email = email.replace(/\bat sign\b/g, ' @ ');
  email = email.replace(/\bat the rate\b/g, ' @ ');
  email = email.replace(/\bat\b/g, ' @ ');
  email = email.replace(/\bdot\b/g, ' . ');
  email = email.replace(/\bperiod\b/g, ' . ');
  email = email.replace(/\bunderscore\b/g, ' _ ');
  email = email.replace(/\bunderscore sign\b/g, ' _ ');
  email = email.replace(/\bhyphen\b/g, ' - ');
  email = email.replace(/\bdash\b/g, ' - ');
  email = email.replace(/\bminus\b/g, ' - ');
  email = email.replace(/\bplus\b/g, ' + ');

  email = email.replace(/\bg mail\b/g, ' gmail ');
  email = email.replace(/\byahoo mail\b/g, ' yahoo ');
  email = email.replace(/\bout look\b/g, ' outlook ');
  email = email.replace(/\bhot mail\b/g, ' hotmail ');
  email = email.replace(/\bi cloud\b/g, ' icloud ');

  const digitMap = {
    zero: '0',
    one: '1',
    two: '2',
    to: '2',
    too: '2',
    three: '3',
    four: '4',
    for: '4',
    five: '5',
    six: '6',
    seven: '7',
    eight: '8',
    ate: '8',
    nine: '9'
  };

  const letterMap = {
    a: 'a',
    ay: 'a',
    b: 'b',
    bee: 'b',
    be: 'b',
    c: 'c',
    cee: 'c',
    see: 'c',
    sea: 'c',
    she: 'c',
    d: 'd',
    dee: 'd',
    e: 'e',
    f: 'f',
    ef: 'f',
    g: 'g',
    gee: 'g',
    h: 'h',
    aitch: 'h',
    i: 'i',
    j: 'j',
    jay: 'j',
    k: 'k',
    kay: 'k',
    l: 'l',
    el: 'l',
    m: 'm',
    em: 'm',
    n: 'n',
    en: 'n',
    o: 'o',
    oh: 'o',
    p: 'p',
    pee: 'p',
    q: 'q',
    cue: 'q',
    queue: 'q',
    r: 'r',
    ar: 'r',
    s: 's',
    ess: 's',
    t: 't',
    tee: 't',
    u: 'u',
    you: 'u',
    v: 'v',
    vee: 'v',
    w: 'w',
    doubleyou: 'w',
    x: 'x',
    ex: 'x',
    y: 'y',
    why: 'y',
    z: 'z',
    zee: 'z',
    zed: 'z'
  };

  const tokens = email.split(/\s+/).filter(Boolean);
  const convertedTokens = tokens.map((token, index) => {
    if (digitMap[token]) {
      return digitMap[token];
    }

    if (letterMap[token]) {
      const next = tokens[index + 1] || '';
      const prev = tokens[index - 1] || '';

      if (
        index === 0 ||
        next === '@' ||
        prev === '@' ||
        /^\d+$/.test(next) ||
        /^\d+$/.test(prev) ||
        next === '.' ||
        prev === '.'
      ) {
        return letterMap[token];
      }
    }

    return token;
  });

  email = convertedTokens.join(' ');

  email = email.replace(/\s*@\s*/g, '@');
  email = email.replace(/\s*\.\s*/g, '.');
  email = email.replace(/\s*_\s*/g, '_');
  email = email.replace(/\s*-\s*/g, '-');
  email = email.replace(/\s*\+\s*/g, '+');
  email = email.replace(/\s+/g, '');
  email = email.replace(/^[._+\-]+/, '');
  email = email.replace(/[._+\-]+$/, '');

  return email;
}

function isStrictEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isAcceptableEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return false;
  if (!/^[a-z0-9@._+\-]+$/.test(value)) return false;
  if (!value.includes('@')) return false;

  const parts = value.split('@');
  if (parts.length !== 2) return false;

  const local = parts[0];
  const domain = parts[1];

  if (!local || local.length < 1) return false;
  if (!domain || domain.length < 2) return false;

  return true;
}

function sanitizeLooseEmail(email) {
  return String(email || '')
    .toLowerCase()
    .replace(/[^a-z0-9@._+\-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/@{2,}/g, '@')
    .replace(/_{2,}/g, '_')
    .replace(/-{2,}/g, '-')
    .replace(/\+{2,}/g, '+')
    .replace(/^[._+\-]+/, '')
    .replace(/[._+\-]+$/, '')
    .trim();
}

function extractEmailFromSpeech(req) {
  const raw = String(req.body.SpeechResult || '').trim();
  if (!raw) return '';

  let email = normalizeEmailSpeech(raw);

  if (isStrictEmail(email) || isAcceptableEmail(email)) {
    return email;
  }

  email = sanitizeLooseEmail(email);

  if (isStrictEmail(email) || isAcceptableEmail(email)) {
    return email;
  }

  const rawCleaned = sanitizeLooseEmail(normalizeEmailSpeech(raw));
  if (isStrictEmail(rawCleaned) || isAcceptableEmail(rawCleaned)) {
    return rawCleaned;
  }

  return rawCleaned;
}

// ===== GPT EMAIL EXTRACTION =====
// Sends raw spoken text to GPT to extract an email address.
// Runs both regex and GPT pipelines, uses GPT tiebreaker if they differ.
async function extractEmailViaGPT(rawSpeechText, callerName) {
  const raw = String(rawSpeechText || '').trim();
  if (!raw) return '';

  // Step 1: Run the regex pipeline
  const regexResult = fallbackExtractEmail(raw);
  console.log('Email regex pipeline result:', regexResult, 'from raw:', raw);

  // Step 2: Run GPT extraction
  const nameHint = callerName ? ` The caller's name is "${callerName}" — the email local part may contain their name or a variation of it (nicknames, abbreviations, with or without numbers). Use this as a hint when the transcription is ambiguous, especially for tricky letters like P/B/T/D.` : '';

  let gptDirect = '';
  try {
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
            content: 'You are an email extraction assistant. The user will give you a transcript of someone speaking or spelling their email address out loud over the phone. Speech-to-text often confuses similar-sounding letters like P/B/T/D, M/N, S/F, and vowels. If the person is spelling letter by letter, treat each word as an individual letter (e.g. "pee" = P, "tee" = T, "oh" = O, "aitch" = H, "ee" = E, "ar" = R). Extract the most likely email address from what they said. Reply with ONLY the email address, nothing else. No quotes, no explanation. If you cannot determine an email address, reply with the single word NONE.' + nameHint
          },
          {
            role: 'user',
            content: raw
          }
        ]
      })
    });

    const data = await response.json();

    if (response.ok) {
      const parsed = parseGPTResponseText(data).trim().toLowerCase();
      if (parsed && parsed !== 'none' && parsed.includes('@')) {
        const sanitized = sanitizeLooseEmail(parsed);
        if (isStrictEmail(sanitized) || isAcceptableEmail(sanitized)) {
          gptDirect = sanitized;
        }
      }
    } else {
      console.error('GPT email extraction API error:', data.error?.message);
    }
  } catch (err) {
    console.error('GPT email extraction error:', err);
  }

  console.log('Email GPT direct result:', gptDirect);

  // Step 3: Trust regex first — handles spelled-out emails better than GPT.
  // GPT often mishears single letters (C→G, P→B, T→D) on phone audio.
  // Only fall back to GPT when regex produces nothing.
  if (!gptDirect && !regexResult) return '';
  if (regexResult) {
    console.log('Email: using regex result:', regexResult);
    return regexResult;
  }
  console.log('Email: regex failed, using GPT result:', gptDirect);
  return gptDirect;

  // Step 4 (kept as safety, rarely reached now)
  console.log('Email candidates differ — regex:', regexResult, 'gpt:', gptDirect, '— running tiebreaker');
  try {
    const tbResponse = await fetch('https://api.openai.com/v1/responses', {
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
            content: 'You are an email validation assistant. The user will give you the raw phone transcript of someone saying their email address, plus two candidate email addresses extracted by different methods. Pick the one that is most likely the correct email address. Consider common speech-to-text errors (P/B/T/D swaps, dropped letters, number confusion). If one candidate looks like a real name or word pattern and the other looks garbled, prefer the real-looking one.' + nameHint + ' Reply with ONLY the winning email address. No explanation.'
          },
          {
            role: 'user',
            content: `Raw transcript: "${raw}"\nCandidate A (letter-by-letter): ${regexResult}\nCandidate B (AI extraction): ${gptDirect}`
          }
        ]
      })
    });

    const tbData = await tbResponse.json();

    if (tbResponse.ok) {
      const winner = parseGPTResponseText(tbData).trim().toLowerCase();
      console.log('Email tiebreaker picked:', winner);
      const sanitizedWinner = sanitizeLooseEmail(winner);
      if (isStrictEmail(sanitizedWinner) || isAcceptableEmail(sanitizedWinner)) {
        return sanitizedWinner;
      }
    }
  } catch (err) {
    console.error('Email tiebreaker error:', err);
  }

  // If tiebreaker failed, prefer regex result for spelled-out emails
  return regexResult;
}

// The existing regex pipeline as a fallback
function fallbackExtractEmail(rawText) {
  let email = normalizeEmailSpeech(rawText);

  if (isStrictEmail(email) || isAcceptableEmail(email)) {
    return email;
  }

  email = sanitizeLooseEmail(email);

  if (isStrictEmail(email) || isAcceptableEmail(email)) {
    return email;
  }

  const rawCleaned = sanitizeLooseEmail(normalizeEmailSpeech(rawText));
  if (isStrictEmail(rawCleaned) || isAcceptableEmail(rawCleaned)) {
    return rawCleaned;
  }

  return rawCleaned;
}

function formatEmailForSpeech(email) {
  const clean = String(email || '').replace(/[._+\-]+$/, '').trim();
  if (!clean || !clean.includes('@')) return clean;

  const [local, domain] = clean.split('@');

  // Spell out the local part letter by letter for clarity
  const spellOut = (str) => {
    return str.split('').map(ch => {
      if (/[a-z]/i.test(ch)) return ch.toUpperCase();
      if (/\d/.test(ch)) return ch;
      if (ch === '.') return 'dot';
      if (ch === '_') return 'underscore';
      if (ch === '-') return 'dash';
      if (ch === '+') return 'plus';
      return ch;
    }).join(', ');
  };

  // Domain stays readable (gmail dot com, not G M A I L dot com)
  const domainSpoken = domain
    .replace(/\./g, ' dot ')
    .replace(/\s+/g, ' ')
    .trim();

  return `${spellOut(local)}, at, ${domainSpoken}`;
}

function loadJobs() {
  if (!fs.existsSync(JOBS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveAllJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function saveJob(job) {
  const jobs = loadJobs();
  jobs.push(job);
  saveAllJobs(jobs);
}

function generateJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getCountyForZip(zip) {
  const matches = [];

  for (const countyName of Object.keys(countyZips)) {
    if (countyZips[countyName].includes(zip)) {
      matches.push(countyName);
    }
  }

  return matches;
}

function getEasternNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function getEasternTimestamp() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date());
}

function formatEasternDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value || '0000';
  const month = parts.find((p) => p.type === 'month')?.value || '00';
  const day = parts.find((p) => p.type === 'day')?.value || '00';

  return `${year}-${month}-${day}`;
}

function getDayNameInEastern(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long'
  }).format(date);
}

function getReadableDate(dateKey) {
  if (!dateKey) return '';
  const dt = new Date(`${dateKey}T12:00:00`);
  return dt.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });
}

function getAppointmentJobsForDate(jobs, serviceDate) {
  return jobs.filter(
    (job) =>
      job.requestType === 'Appointment Request' &&
      job.serviceDate === serviceDate
  );
}

function formatDateShort(serviceDate) {
  const dt = new Date(`${serviceDate}T12:00:00`);
  return dt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric'
  });
}

function formatSlotPhrase(slot) {
  const date = formatDateShort(slot.serviceDate);
  const day = slot.serviceDay;
  if (slot.serviceWindow === '10:00 to 12:00') {
    return `${day}, ${date}, morning from 10:00 to noon`;
  }
  if (slot.serviceWindow === '1:00 to 4:00') {
    return `${day}, ${date}, afternoon from 1:00 to 4:00`;
  }
  return `${day}, ${date}, ${slot.serviceWindow}`;
}

function buildAvailabilitySpeech(slots) {
  if (!slots || !slots.length) {
    return 'There are no available appointments right now.';
  }

  if (slots.length === 1) {
    return `The earliest I have for your ZIP code is ${formatSlotPhrase(slots[0])}. Does that work for you?`;
  }

  const options = slots.map(formatSlotPhrase);
  return `For your ZIP code, I have ${options.join(', ')}. Which would you prefer?`;
}
function detectNaturalSlot(req, slots) {
  const speech = (req.body.SpeechResult || '').toLowerCase();
  if (!speech) return null;

  for (const slot of slots) {
    const day = slot.serviceDay.toLowerCase();
    const date = new Date(`${slot.serviceDate}T12:00:00`);
    const month = date.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
    const dayNum = String(date.getDate());
    const isMorning = slot.serviceWindow === '10:00 to 12:00';
    const isAfternoon = slot.serviceWindow === '1:00 to 4:00';

    // DAY MATCH (Mon-Thu)
    if (speech.includes(day) && slot.serviceWindow === '10:00 to 10:30') {
      return slot;
    }
    // FRIDAY/SATURDAY MORNING/AFTERNOON
    if (speech.includes(day) && isMorning && speech.includes('morning')) {
      return slot;
    }
    if (speech.includes(day) && isAfternoon && speech.includes('afternoon')) {
      return slot;
    }
    // DATE MATCH
    if (speech.includes(month) && speech.includes(dayNum)) {
      return slot;
    }
  }

  return null;
}

function detectFutureOffsetDays(text) {
  const cleaned = cleanText(text);

  if (
    cleaned.includes('two weeks') ||
    cleaned.includes('2 weeks') ||
    cleaned.includes('2 week') ||
    cleaned.includes('two week')
  ) {
    return 14;
  }

  if (
    cleaned.includes('three weeks') ||
    cleaned.includes('3 weeks') ||
    cleaned.includes('3 week') ||
    cleaned.includes('three week')
  ) {
    return 21;
  }

  if (cleaned.includes('next week') || cleaned.includes('week out') || cleaned === 'week') {
    return 7;
  }

  if (cleaned.includes('later this week') || cleaned.includes('later')) {
    return 4;
  }

  return null;
}

function detectOptionSelection(req) {
  const digit = String(req.body.Digits || '').trim();
  if (digit === '1' || digit === '2' || digit === '3') {
    return parseInt(digit, 10);
  }

  const cleaned = cleanText(req.body.SpeechResult || '');

  if (cleaned.includes('option 1') || cleaned === '1' || cleaned.includes('one')) {
    return 1;
  }

  if (
    cleaned.includes('option 2') ||
    cleaned === '2' ||
    cleaned.includes('two') ||
    cleaned.includes('second')
  ) {
    return 2;
  }

  if (
    cleaned.includes('option 3') ||
    cleaned === '3' ||
    cleaned.includes('three') ||
    cleaned.includes('third')
  ) {
    return 3;
  }

  return null;
}

function detectCorrectionField(text) {
  const cleaned = cleanText(text);

  if (cleaned.includes('phone')) return 'phone';
  if (cleaned.includes('address') || cleaned.includes('street')) return 'address';
  if (cleaned.includes('name')) return 'name';
  if (cleaned.includes('machine') || cleaned.includes('mower') || cleaned.includes('generator') || cleaned.includes('washer') || cleaned.includes('snowblower')) return 'machine';
  if (cleaned.includes('problem') || cleaned.includes('issue')) return 'issue';
  if (cleaned.includes('appointment') || cleaned.includes('time') || cleaned.includes('option') || cleaned.includes('date') || cleaned.includes('schedule')) return 'appointment';

  return '';
}

function getBaseUrl(req) {
  const protoHeader = req.headers['x-forwarded-proto'];
  const protocol = protoHeader ? protoHeader.split(',')[0] : req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function absoluteUrl(req, path) {
  return `${getBaseUrl(req)}${path}`;
}

function buildSafeErrorTwiml() {
  return `
<Response>
  ${say("Sorry, something went wrong on our end. Please call back in a moment. Goodbye.")}
</Response>
`.trim();
}

function wrapRoute(handler) {
  return async (req, res, next) => {
    try {
      await Promise.resolve(handler(req, res, next));
    } catch (error) {
      console.error('Route error:', error);
      if (!res.headersSent) {
        res.type('text/xml');
        res.status(200).send(buildSafeErrorTwiml());
      }
    }
  };
}

function detectYesNoOrDigits(req) {
  const digit = String(req.body.Digits || '').trim();
  if (digit === '1') return 'yes';
  if (digit === '2') return 'no';

  const text = cleanText(req.body.SpeechResult || '');
  if (
    text.includes('yes') ||
    text.includes('correct') ||
    text.includes('that is correct') ||
    text.includes('sounds correct')
  ) {
    return 'yes';
  }

  if (
    text.includes('no') ||
    text.includes('not correct') ||
    text.includes('wrong') ||
    text.includes('change it')
  ) {
    return 'no';
  }

  return '';
}

function buildAppointmentConfirmationTwiml(req, {
  machine,
  issue,
  zip,
  serviceDate,
  serviceDay,
  serviceCounty,
  serviceWindow,
  name,
  phone,
  address
}) {
  const readableDate = getReadableDate(serviceDate);
  const spokenAddress = formatAddressForSpeech(address);
  const actionUrl = absoluteUrl(
    req,
    `/finalConfirmAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
  );

  return `
<Response>
  ${say("Let me confirm everything.")}
  ${pause(1)}
  ${say(`I have your name as ${name}, phone number ${digitsToWords(phone)}, zip code ${digitsToWords(zip)}, service address ${spokenAddress}, and your ${machine} has ${issue}.`)}
  ${pause(1)}
  ${say(`The available appointment is ${readableDate} between ${serviceWindow}.`)}
  ${pause(1)}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Does that all sound correct? Please say yes or no. You can also press 1 for yes or 2 for no.")}
  </Gather>
  ${say("I did not catch that.")}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Please say yes if everything is correct, or say no if something needs to be fixed. You can also press 1 for yes or 2 for no.")}
  </Gather>
  ${say("I still did not hear anything. Goodbye.")}
</Response>
`.trim();
}

function buildMessageConfirmationTwiml(req, {
  machine,
  issue,
  name,
  phone,
  address
}) {
  const spokenAddress = formatAddressForSpeech(address);
  const actionUrl = absoluteUrl(
    req,
    `/finalConfirmMessage?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
  );

  return `
<Response>
  ${say("Let me confirm everything.")}
  ${pause(1)}
  ${say(`I have your name as ${name}, phone number ${digitsToWords(phone)}, service address ${spokenAddress}, and your ${machine} has ${issue}.`)}
  ${pause(1)}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Does that all sound correct? Please say yes or no. You can also press 1 for yes or 2 for no.")}
  </Gather>
  ${say("I did not catch that.")}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Please say yes if everything is correct, or say no if something needs to be fixed. You can also press 1 for yes or 2 for no.")}
  </Gather>
  ${say("I still did not hear anything. Goodbye.")}
</Response>
`.trim();
}

function buildEmailConfirmationTwiml(req, {
  machine,
  issue,
  zip,
  serviceDate,
  serviceDay,
  serviceCounty,
  serviceWindow,
  name,
  phone,
  address,
  email
}) {
  const actionUrl = absoluteUrl(
    req,
    `/confirmAppointmentEmail?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}&email=${encodeURIComponent(email)}`
  );

  return `
<Response>
  ${say(`I heard ${formatEmailForSpeech(email)}.`)}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Is that correct? Please say yes or no. You can also press 1 for yes or 2 for no.")}
  </Gather>
  ${say("I did not catch that.")}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Please say yes if the email is correct, or say no to say it again. You can also press 1 for yes or 2 for no.")}
  </Gather>
  ${say("I still did not hear anything. Goodbye.")}
</Response>
`.trim();
}

// ===== ZIP COORDINATES + DISTANCE =====
const zipCoordCache = {};
const zipPlaceCache = {};

async function getZipCoordinates(zip) {
  if (!zip) return null;
  if (zipCoordCache[zip]) return zipCoordCache[zip];

  try {
    const response = await fetch(`https://api.zippopotam.us/us/${zip}`);
    if (!response.ok) return null;

    const data = await response.json();
    const place = data?.places?.[0];
    if (!place) return null;

    const coords = {
      lat: parseFloat(place.latitude),
      lon: parseFloat(place.longitude)
    };

    if (Number.isNaN(coords.lat) || Number.isNaN(coords.lon)) return null;

    zipCoordCache[zip] = coords;
    return coords;
  } catch (error) {
    console.error('ZIP lookup error:', error);
    return null;
  }
}

async function getZipPlaceInfo(zip) {
  if (!zip) return null;
  if (zipPlaceCache[zip]) return zipPlaceCache[zip];

  try {
    const response = await fetch(`https://api.zippopotam.us/us/${zip}`);
    if (!response.ok) return null;

    const data = await response.json();
    const place = data?.places?.[0];
    if (!place) return null;

    const info = {
      city: String(place['place name'] || '').trim(),
      state: String(place.state || '').trim(),
      stateAbbreviation: String(place['state abbreviation'] || '').trim()
    };

    zipPlaceCache[zip] = info;
    return info;
  } catch (error) {
    console.error('ZIP place lookup error:', error);
    return null;
  }
}

// Local ZIP→city lookup — no external API call, no latency risk on live calls.
const localZipCityMap = {
  '20701': 'Annapolis Junction', '21029': 'Clarksville', '21044': 'Columbia',
  '21045': 'Columbia', '21046': 'Columbia', '21075': 'Elkridge', '20759': 'Fulton',
  '21076': 'Hanover', '20777': 'Highland', '20794': 'Jessup', '20723': 'Laurel',
  '21042': 'Ellicott City', '21043': 'Ellicott City',
  '21401': 'Annapolis', '21402': 'Annapolis', '21403': 'Annapolis',
  '21012': 'Arnold', '21114': 'Crofton', '21032': 'Crownsville',
  '21035': 'Davidsonville', '21037': 'Edgewater', '21054': 'Gambrills',
  '21060': 'Glen Burnie', '21061': 'Glen Burnie', '21077': 'Harmans',
  '20776': 'Harwood', '21090': 'Linthicum', '21108': 'Millersville',
  '21113': 'Odenton', '21122': 'Pasadena', '21140': 'Riva',
  '21144': 'Severn', '21146': 'Severna Park', '20724': 'Laurel',
  '20707': 'Laurel', '20705': 'Beltsville', '20708': 'Laurel',
  '20783': 'Hyattsville', '20742': 'College Park', '20771': 'Greenbelt',
  '20769': 'Glenn Dale', '20706': 'Lanham', '20737': 'Riverdale',
  '20782': 'Hyattsville', '20781': 'Bladensburg', '20784': 'Hyattsville',
  '20720': 'Bowie', '20715': 'Bowie', '20721': 'Mitchellville',
  '20716': 'Bowie', '20785': 'Hyattsville', '20743': 'Capitol Heights',
  '20747': 'District Heights', '20746': 'Suitland', '20774': 'Upper Marlboro',
  '20748': 'Temple Hills', '20745': 'Oxon Hill', '20735': 'Clinton',
  '20772': 'Upper Marlboro', '20623': 'Brandywine', '20744': 'Fort Washington',
  '20607': 'Accokeek', '20613': 'Brandywine',
  '21228': 'Catonsville', '21227': 'Halethorpe', '21208': 'Pikesville',
  '21133': 'Randallstown', '21136': 'Reisterstown', '21244': 'Windsor Mill',
  '21163': 'Woodstock'
};

function normalizeAddressForKnownZip(rawAddress, expectedZip) {
  const rejoined = rejoinSpacedDigits(rawAddress || '');
  let streetOnly = normalizeAddressText(rejoined);

  if (!expectedZip) return streetOnly;

  // Strip trailing ZIP
  streetOnly = removeTrailingZipOnly(streetOnly, expectedZip);

  // Strip trailing "Maryland" or "MD" (with or without ZIP after it)
  streetOnly = streetOnly.replace(/\s+Maryland\s*\d{0,5}\s*$/i, '').trim();
  streetOnly = streetOnly.replace(/\s+MD\s*\d{0,5}\s*$/i, '').trim();

  const city = localZipCityMap[expectedZip] || '';

  // Strip city if caller already said it (prevent double city)
  if (city) {
    const cityEscaped = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    streetOnly = streetOnly.replace(new RegExp(`\\s*\\b${cityEscaped}\\b\\s*$`, 'gi'), '').replace(/\s+/g, ' ').trim();
  }

  const cityPart = city ? ` ${city}` : '';
  return `${streetOnly}${cityPart} Maryland ${expectedZip}`.replace(/\s+/g, ' ').trim();
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMiles * c;
}

async function getDistanceFromHomeMiles(zip) {
  const homeCoords = await getZipCoordinates(routingConfig.homeZip);
  const jobCoords = await getZipCoordinates(zip);

  if (!homeCoords || !jobCoords) return 999999;

  return haversineMiles(homeCoords.lat, homeCoords.lon, jobCoords.lat, jobCoords.lon);
}

// ===== MACHINE DETECTION =====
function detectMachine(input) {
  const cleaned = cleanText(applyLocalCorrections(input));

  for (const machineType of config.machineTypes) {
    for (const keyword of machineType.keywords) {
      if (keyword.includes(' ')) {
        // Multi-word keyword — check includes
        if (cleaned.includes(keyword)) return machineType.name;
      } else {
        // Single-word keyword — check includes (matches original behavior)
        if (cleaned.includes(keyword)) return machineType.name;
      }
    }
  }

  return null;
}

// ===== PHONE PARSING =====
function normalizeSpokenDigits(text) {
  let t = ` ${String(text || '').toLowerCase()} `;

  const replacements = [
    [/dash|hyphen|minus/g, ' '],
    [/open parenthesis|close parenthesis|parenthesis/g, ' '],
    [/dot|period/g, ' '],
    [/double oh|double o/g, ' 0 0 '],
    [/triple oh|triple o/g, ' 0 0 0 '],
    [/\boh\b/g, ' 0 '],
    [/\bo\b/g, ' 0 '],
    [/\bzero\b/g, ' 0 '],
    [/\bone\b/g, ' 1 '],
    [/\btwo\b|\bto\b|\btoo\b/g, ' 2 '],
    [/\bthree\b/g, ' 3 '],
    [/\bfour\b|\bfor\b/g, ' 4 '],
    [/\bfive\b/g, ' 5 '],
    [/\bsix\b/g, ' 6 '],
    [/\bseven\b/g, ' 7 '],
    [/\beight\b|\bate\b/g, ' 8 '],
    [/\bnine\b/g, ' 9 ']
  ];

  for (const [pattern, replacement] of replacements) {
    t = t.replace(pattern, replacement);
  }

  return t.replace(/\D/g, '');
}

function normalizeTenDigitPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');

  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }

  if (digits.length >= 10) {
    return digits.slice(0, 10);
  }

  return '';
}

function extractPhoneFromRequest(req) {
  const dtmf = normalizeTenDigitPhone(req.body.Digits || '');
  if (dtmf) {
    return dtmf;
  }

  const speech = req.body.SpeechResult || '';
  const speechDigits = normalizeTenDigitPhone(normalizeSpokenDigits(speech));
  if (speechDigits) {
    return speechDigits;
  }

  return '';
}

// ===== ADDRESS PARSING =====
function extractAddressFromSpeech(req) {
  const raw = String(req.body.SpeechResult || '').trim();
  if (!raw) return '';
  return normalizeAddressText(raw);
}

// ===== AVAILABILITY / ROUTING =====
async function rebalanceFridaySaturdayJobs(serviceDate) {
  const jobs = loadJobs();
  const dayJobs = jobs.filter(
    (job) =>
      job.requestType === 'Appointment Request' &&
      job.serviceDate === serviceDate
  );

  if (dayJobs.length === 0) return;

  const FAR_THRESHOLD_MILES = 10;

  const enriched = [];
  for (const job of dayJobs) {
    const distance = await getDistanceFromHomeMiles(job.zip);
    enriched.push({ job, distance });
  }

  // Count how many near vs far jobs there are
  const nearJobs = enriched.filter(e => e.distance <= FAR_THRESHOLD_MILES);
  const farJobs = enriched.filter(e => e.distance > FAR_THRESHOLD_MILES);

  // Assign near jobs to morning (up to morningMax), overflow to afternoon
  // Assign far jobs to afternoon (up to afternoonMax), overflow to morning
  let morningUsed = 0;
  let afternoonUsed = 0;

  for (const entry of nearJobs) {
    if (morningUsed < routingConfig.fridaySaturdayMorningMax) {
      entry.job.serviceWindow = routingConfig.fridaySaturdayMorningWindow;
      morningUsed++;
    } else if (afternoonUsed < routingConfig.fridaySaturdayAfternoonMax) {
      entry.job.serviceWindow = routingConfig.fridaySaturdayAfternoonWindow;
      afternoonUsed++;
    } else {
      entry.job.serviceWindow = 'We will contact you to schedule your service window.';
    }
  }

  for (const entry of farJobs) {
    if (afternoonUsed < routingConfig.fridaySaturdayAfternoonMax) {
      entry.job.serviceWindow = routingConfig.fridaySaturdayAfternoonWindow;
      afternoonUsed++;
    } else if (morningUsed < routingConfig.fridaySaturdayMorningMax) {
      entry.job.serviceWindow = routingConfig.fridaySaturdayMorningWindow;
      morningUsed++;
    } else {
      entry.job.serviceWindow = 'We will contact you to schedule your service window.';
    }
  }

  saveAllJobs(jobs);
}

async function buildFridaySaturdayDistancePlan(zip, serviceDate, dayName) {
  const matchingCounties = getCountyForZip(zip);
  if (matchingCounties.length === 0) return null;

  const allowed =
    dayName === 'Friday'
      ? routingConfig.fridayAllowedCounties
      : routingConfig.saturdayAllowedCounties;

  const matchedAllowed = matchingCounties.find((county) =>
    allowed.includes(county)
  );

  if (!matchedAllowed) {
    return null;
  }

  const existingJobs = loadJobs();
  const dayJobs = getAppointmentJobsForDate(existingJobs, serviceDate);
  const maxJobsForDay =
    routingConfig.fridaySaturdayMorningMax +
    routingConfig.fridaySaturdayAfternoonMax;

  if (dayJobs.length >= maxJobsForDay) {
    return null;
  }

  const compareList = dayJobs.map((job) => ({
    id: job.id,
    zip: job.zip,
    serviceWindow: job.serviceWindow
  }));
  compareList.push({ id: '__temp__', zip, serviceWindow: '' });

  const enriched = [];
  for (const item of compareList) {
    const distance = await getDistanceFromHomeMiles(item.zip);
    enriched.push({ ...item, distance });
  }

  const tempEntry = enriched.find((item) => item.id === '__temp__');
  const tempDistance = tempEntry ? tempEntry.distance : 0;
  console.log(`[DISTANCE] zip=${zip} date=${serviceDate} day=${dayName} distance=${tempDistance}mi isFar=${tempDistance > 10}`);

  const morningJobs = dayJobs.filter(
    (job) => job.serviceWindow === routingConfig.fridaySaturdayMorningWindow
  );
  const afternoonJobs = dayJobs.filter(
    (job) => job.serviceWindow === routingConfig.fridaySaturdayAfternoonWindow
  );

  const morningOpenSpots = Math.max(routingConfig.fridaySaturdayMorningMax - morningJobs.length, 0);
  const afternoonOpenSpots = Math.max(routingConfig.fridaySaturdayAfternoonMax - afternoonJobs.length, 0);

  // Far ZIPs (>10 miles) default to afternoon; near ZIPs default to morning
  // Only overflow to the other window if preferred window is full
  const FAR_THRESHOLD_MILES = 10;
  const isFar = tempDistance > FAR_THRESHOLD_MILES;

  let serviceWindow;
  if (isFar) {
    if (afternoonOpenSpots > 0) {
      serviceWindow = routingConfig.fridaySaturdayAfternoonWindow;
    } else if (morningOpenSpots > 0) {
      serviceWindow = routingConfig.fridaySaturdayMorningWindow;
    } else {
      return null;
    }
  } else {
    if (morningOpenSpots > 0) {
      serviceWindow = routingConfig.fridaySaturdayMorningWindow;
    } else if (afternoonOpenSpots > 0) {
      serviceWindow = routingConfig.fridaySaturdayAfternoonWindow;
    } else {
      return null;
    }
  }

  const tempIndex = enriched.findIndex((item) => item.id === '__temp__');

  return {
    serviceDate,
    serviceDay: dayName,
    serviceCounty: matchedAllowed,
    serviceWindow,
    tempIndex,
    morningOpenSpots,
    afternoonOpenSpots,
    maxJobsForDay
  };
}

async function getSlotForDate(zip, serviceDate, dayName) {
  const matchingCounties = getCountyForZip(zip);
  if (matchingCounties.length === 0) return null;

  const existingJobs = loadJobs();
  const dayJobs = getAppointmentJobsForDate(existingJobs, serviceDate);

  if (
    dayName === 'Monday' ||
    dayName === 'Tuesday' ||
    dayName === 'Wednesday' ||
    dayName === 'Thursday'
  ) {
    if (dayJobs.length < routingConfig.mondayThursdayMax) {
      return {
        serviceDate,
        serviceDay: dayName,
        serviceCounty: matchingCounties[0] || '',
        serviceWindow: routingConfig.mondayThursdayWindow
      };
    }

    return null;
  }

  if (dayName === 'Friday' || dayName === 'Saturday') {
    const distancePlan = await buildFridaySaturdayDistancePlan(zip, serviceDate, dayName);
    if (!distancePlan) {
      return null;
    }

    return {
      serviceDate,
      serviceDay: dayName,
      serviceCounty: distancePlan.serviceCounty,
      serviceWindow: distancePlan.serviceWindow
    };
  }

  return null;
}

async function findAvailableSlots(zip, startOffsetDays = 1, maxSlots = 3) {
  const matchingCounties = getCountyForZip(zip);
  if (matchingCounties.length === 0) {
    return [];
  }

  const results = [];
  const now = getEasternNow();
  const seenDates = new Set();

  for (let offset = startOffsetDays; offset <= 30; offset += 1) {
    if (results.length >= maxSlots) {
      break;
    }

    const future = new Date(now);
    future.setDate(now.getDate() + offset);

    const serviceDate = formatEasternDateKey(future);
    const dayName = getDayNameInEastern(future);

    if (dayName === 'Sunday') {
      continue;
    }

    if ((dayName === 'Friday' || dayName === 'Saturday') && !seenDates.has(serviceDate)) {
      const distancePlan = await buildFridaySaturdayDistancePlan(zip, serviceDate, dayName);
      if (distancePlan && results.length < maxSlots) {
        const targetWindow = distancePlan.serviceWindow;
        const targetWindowHasCapacity =
          targetWindow === routingConfig.fridaySaturdayMorningWindow
            ? distancePlan.morningOpenSpots > 0
            : distancePlan.afternoonOpenSpots > 0;

        if (targetWindowHasCapacity) {
          results.push({
            serviceDate,
            serviceDay: dayName,
            serviceCounty: distancePlan.serviceCounty,
            serviceWindow: targetWindow,
            readableDate: getReadableDate(serviceDate)
          });
        }

        seenDates.add(serviceDate);
      }
      continue;
    }

    if (seenDates.has(serviceDate)) continue;

    const slot = await getSlotForDate(zip, serviceDate, dayName);

    if (slot) {
      results.push({
        ...slot,
        readableDate: getReadableDate(slot.serviceDate)
      });
      seenDates.add(serviceDate);
    }
  }

  return results;
}

// ===== CALL FLOW START =====
function buildVoiceTwiml(req) {
  const wsUrl = `wss://${req.get('host')}/conversation-relay`;

  return `
<Response>
  <Connect>
    <ConversationRelay
      url="${xmlEscape(wsUrl)}"
      welcomeGreeting="${xmlEscape(config.welcomeGreeting)}"
      interruptible="false"
    />
  </Connect>
</Response>
`.trim();
}


app.get('/', (req, res) => {
  res.send(config.homepageText);
});

// ===== TEST EMAIL ROUTE =====
app.get('/test-email', wrapRoute(async (req, res) => {
  const to = req.query.to || config.testEmailTo;

  try {
    const result = await sendAppointmentConfirmationEmail({
      to,
      name: 'Test Customer',
      machine: 'Snowblower',
      issue: 'Test email check',
      serviceDate: formatEasternDateKey(getEasternNow()),
      serviceWindow: '10:00 to 12:00',
      address: config.testAddress
    });
    res.status(200).type('text/plain').send('EMAIL SENT TO: ' + to + ' id: ' + result.id);
  } catch (error) {
    res.status(200).type('text/plain').send('TEST EMAIL FAILED: ' + (error && error.message ? error.message : String(error)));
  }
}));

app.get('/test-ai', wrapRoute(async (req, res) => {
  const reply = await getAIResponse('Customer says: My riding mower will not start and I am in zip code 21144. What would you say next?');
  res.status(200).type('text/plain').send(reply);
}));

app.get('/test-ai-debug', wrapRoute(async (req, res) => {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: 'Say hello.' },
        { role: 'user', content: 'Hi' }
      ]
    })
  });
  const data = await response.json();
  res.status(200).type('application/json').send(JSON.stringify(data, null, 2));
}));

app.get('/voice', wrapRoute((req, res) => {
  res.type('text/xml');
  res.send(buildVoiceTwiml(req));
}));

app.post('/voice', wrapRoute((req, res) => {
  res.type('text/xml');
  res.send(buildVoiceTwiml(req));
}));

// ===== STEP 1: HELP REQUEST / EXTRACT MACHINE =====
app.post('/getHelpRequest', wrapRoute(async (req, res) => {
  const helpRequest = req.body.SpeechResult || '';
  const detectedMachine = detectMachine(helpRequest);

  const retryUrl = absoluteUrl(req, '/getHelpRequest');
  const issueUrl = absoluteUrl(
    req,
    `/getIssue?machine=${encodeURIComponent(detectedMachine || '')}`
  );

  let aiReply = '';

  try {
    if (!detectedMachine) {
      aiReply = await getAIResponse(
        `Customer said: "${helpRequest}". The machine type is unclear. Reply in one short natural sentence asking what type of equipment they need help with. Do not ask about brand, model, ZIP code, phone number, address, email, or scheduling yet.`
      );
    } else {
      aiReply = await getAIResponse(
        `Customer said: "${helpRequest}". The detected machine is "${detectedMachine}". Reply in one short natural sentence acknowledging that machine and asking them to briefly describe the problem. Do not ask about brand, model, ZIP code, phone number, address, email, or scheduling yet.`
      );
    }
  } catch (error) {
    console.error('AI getHelpRequest error:', error);
  }

  res.type('text/xml');

  if (!detectedMachine) {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="6">
    ${say(aiReply || "I want to make sure I got the right equipment. What type of machine do you need help with?")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(issueUrl)}" method="POST" speechTimeout="auto" timeout="6">
    ${say(aiReply || `Got it. Please briefly describe the problem with your ${detectedMachine}.`)}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
}));

// ===== STEP 2: ISSUE =====
app.post('/getIssue', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = normalizeIssueText(req.body.SpeechResult || 'Unknown');

  const nextUrl = absoluteUrl(
    req,
    `/scheduleDecision?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}`
  );

  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(nextUrl)}" method="POST" speechTimeout="auto" timeout="5">
    ${say("Would you like to schedule an appointment?")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
}));

// ===== STEP 3: SCHEDULE DECISION =====
app.post('/scheduleDecision', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const decision = cleanText(req.body.SpeechResult || '');

  const wantsAppointment =
    decision.includes('yes') ||
    decision.includes('schedule') ||
    decision.includes('book') ||
    decision.includes('appointment');

  const zipUrl = absoluteUrl(
    req,
    `/getZipForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}`
  );

  const messageNameUrl = absoluteUrl(
    req,
    `/getNameForMessage?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}`
  );

  res.type('text/xml');

  if (wantsAppointment) {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(zipUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("What is your five digit ZIP code?")}
  </Gather>
  ${say("We did not receive your ZIP code. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(messageNameUrl)}" method="POST" speechTimeout="4" timeout="10">
    ${say("No problem. Can I get your first and last name, please?")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
}));

// ===== STEP 4A: APPOINTMENT ZIP / CHECK AVAILABILITY =====
app.post('/getZipForAppointment', wrapRoute(async (req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const spokenLocation = String(req.body.SpeechResult || '').trim();
  const zip = normalizeSpokenDigits(spokenLocation).slice(0, 5);

  res.type('text/xml');

  if (!zip || zip.length !== 5) {
    const retryUrl = absoluteUrl(
      req,
      `/getZipForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("I need the five digit ZIP code. Please say it again.")}
  </Gather>
  ${say("We did not receive your ZIP code. Goodbye.")}
</Response>
`.trim());
    return;
  }

  const placeInfo = await getZipPlaceInfo(zip);
  const city = placeInfo?.city || '';
  const slots = await findAvailableSlots(zip, 1, 7);

  if (!slots.length) {
    res.send(`
<Response>
  ${say(`Sorry, zip code ${digitsToWords(zip)} is not in our service area or there are no available appointments right now.`)}
  ${say("Please call again if you need anything else. Goodbye.")}
</Response>
`.trim());
    return;
  }

  const speech = buildAvailabilitySpeech(slots);
  const selectUrl = absoluteUrl(
    req,
    `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&city=${encodeURIComponent(city)}&startOffset=1`
  );

  res.send(`
<Response>
  ${say(`Thanks. Zip code ${digitsToWords(zip)} is in our service area.`)}
  ${pause(1)}
  ${say(speech)}
  <Gather input="speech" action="${xmlEscape(selectUrl)}" method="POST" speechTimeout="auto">
    ${say("You can say a day, a date, or Friday or Saturday morning or afternoon.")}
  </Gather>
</Response>
`.trim());
}));

// ===== STEP 4B: APPOINTMENT OPTION SELECTION =====
app.post('/selectAppointmentOption', wrapRoute(async (req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const city = req.query.city || '';
  const currentStartOffset = parseInt(req.query.startOffset || '1', 10);

  const speechText = req.body.SpeechResult || '';
  const futureOffset = detectFutureOffsetDays(speechText);

  res.type('text/xml');

  if (futureOffset !== null) {
    const futureSlots = await findAvailableSlots(zip, futureOffset, 3);

    if (!futureSlots.length) {
      const retryUrl = absoluteUrl(
        req,
        `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&city=${encodeURIComponent(city)}&startOffset=${encodeURIComponent(currentStartOffset)}`
      );

      res.send(`
<Response>
  ${say("I could not find appointments in that time frame.")}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Please say or press option 1, 2, or 3.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
      return;
    }

    const futureSpeech = buildOptionSpeech(futureSlots);
    const futureUrl = absoluteUrl(
      req,
      `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&city=${encodeURIComponent(city)}&startOffset=${encodeURIComponent(futureOffset)}`
    );

    res.send(`
<Response>
  ${say(futureSpeech)}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(futureUrl)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Press or say option 1, 2, or 3.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  const currentSlots = await findAvailableSlots(zip, currentStartOffset, 7);
  const chosenSlot = detectNaturalSlot(req, currentSlots);

  if (!chosenSlot) {
    const retryUrl = absoluteUrl(
      req,
      `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&city=${encodeURIComponent(city)}&startOffset=${encodeURIComponent(currentStartOffset)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto">
    ${say("I didn't catch that. Please say the day, the date, or Friday or Saturday morning or afternoon.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (!chosenSlot) {
    const retryUrl = absoluteUrl(
      req,
      `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&city=${encodeURIComponent(city)}&startOffset=${encodeURIComponent(currentStartOffset)}`
    );

    res.send(`
<Response>
  ${say("That option is not available.")}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Please say or press option 1, 2, or 3.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  const nameUrl = absoluteUrl(
    req,
    `/getNameForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&city=${encodeURIComponent(city)}&serviceDate=${encodeURIComponent(chosenSlot.serviceDate)}&serviceDay=${encodeURIComponent(chosenSlot.serviceDay)}&serviceCounty=${encodeURIComponent(chosenSlot.serviceCounty)}&serviceWindow=${encodeURIComponent(chosenSlot.serviceWindow)}`
  );

  res.send(`
<Response>
  ${say(`Great. You selected ${chosenSlot.readableDate}, between ${chosenSlot.serviceWindow}.`)}
  ${pause(1)}
  <Gather input="speech" action="${xmlEscape(nameUrl)}" method="POST" speechTimeout="4" timeout="10">
    ${say("Can I get your first and last name, please?")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
}));

// ===== STEP 5A: APPOINTMENT NAME =====
app.post('/getNameForAppointment', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const city = req.query.city || '';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const name = normalizeNameText(req.body.SpeechResult);

  const phoneUrl = absoluteUrl(
    req,
    `/getPhoneForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&city=${encodeURIComponent(city)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}`
  );

  res.type('text/xml');
  res.send(`
<Response>
  ${say(`Thanks, ${name}.`)}
  ${pause(1)}
  <Gather input="speech dtmf" numDigits="10" action="${xmlEscape(phoneUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("What is the best phone number to reach you at? You can say it or enter it on your keypad.")}
  </Gather>
  ${say("We did not receive your phone number. Goodbye.")}
</Response>
`.trim());
}));

// ===== STEP 5B: APPOINTMENT PHONE =====
app.post('/getPhoneForAppointment', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const city = req.query.city || '';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const name = req.query.name || 'Unknown';
  const phone = extractPhoneFromRequest(req);

  const retryPhoneUrl = absoluteUrl(
    req,
    `/getPhoneForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}`
  );

  const confirmPhoneUrl = absoluteUrl(
    req,
    `/confirmPhoneForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`
  );

  res.type('text/xml');

  if (!phone || phone.length < 10) {
    res.send(`
<Response>
  <Gather input="speech dtmf" numDigits="10" action="${xmlEscape(retryPhoneUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("I did not get the phone number. Please say it again or enter it using your keypad.")}
  </Gather>
  ${say("We did not receive your phone number. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  ${say(`I heard ${digitsToWords(phone)}.`)}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(confirmPhoneUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Is that correct? Please say yes or no. You can also press 1 for yes or 2 for no.")}
  </Gather>
  ${say("I did not catch that.")}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(confirmPhoneUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Please say yes if the phone number is correct, or say no to give it again. You can also press 1 for yes or 2 for no.")}
  </Gather>
  ${say("I still did not hear anything. Goodbye.")}
</Response>
`.trim());
}));

// ===== STEP 5B-2: APPOINTMENT PHONE CONFIRM =====
app.post('/confirmPhoneForAppointment', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const city = req.query.city || '';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const decision = detectYesNoOrDigits(req);

  const phoneRetryUrl = absoluteUrl(
    req,
    `/getPhoneForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}`
  );

  const addressUrl = absoluteUrl(
    req,
    `/getAddressForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`
  );

  res.type('text/xml');

  if (decision !== 'yes') {
    res.send(`
<Response>
  <Gather input="speech dtmf" numDigits="10" action="${xmlEscape(phoneRetryUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Okay. Please say or enter the phone number again.")}
  </Gather>
  ${say("We did not receive your phone number. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  ${say("Thanks.")}
  ${pause(1)}
  <Gather input="speech" action="${xmlEscape(addressUrl)}" method="POST" speechTimeout="auto" timeout="20">
    ${say("What is the service address? Please say the full street address.")}
  </Gather>
  ${say("We did not hear the address. Goodbye.")}
</Response>
`.trim());
}));

// ===== STEP 5C: APPOINTMENT ADDRESS =====
app.post('/getAddressForAppointment', wrapRoute(async (req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const rawAddress = String(req.body.SpeechResult || '').trim();
  const address = normalizeAddressForKnownZip(rawAddress, zip);

  const sameAddressUrl = absoluteUrl(
    req,
    `/getAddressForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`
  );

  res.type('text/xml');

  if (!address || address.length < 5) {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(sameAddressUrl)}" method="POST" speechTimeout="auto" timeout="20">
    ${say("I did not get the address. Please say the full service address again.")}
  </Gather>
  ${say("We still did not get the address. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(
    buildAppointmentConfirmationTwiml(req, {
      machine,
      issue,
      zip,
      serviceDate,
      serviceDay,
      serviceCounty,
      serviceWindow,
      name,
      phone,
      address
    })
  );
}));

// ===== APPOINTMENT CORRECTION CHOICE =====
app.post('/appointmentCorrectionChoice', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = req.query.address || '';
  const correctionField = detectCorrectionField(req.body.SpeechResult || '');

  res.type('text/xml');

  if (!correctionField) {
    const retryUrl = absoluteUrl(
      req,
      `/appointmentCorrectionChoice?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Please tell me what needs to be corrected. You can say name, phone number, address, machine, issue, or appointment.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (correctionField === 'name') {
    const url = absoluteUrl(
      req,
      `/correctAppointmentName?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(url)}" method="POST" speechTimeout="4" timeout="10">
    ${say("Please say the correct first and last name.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (correctionField === 'phone') {
    const url = absoluteUrl(
      req,
      `/getPhoneForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}`
    );

    res.send(`
<Response>
  <Gather input="speech dtmf" numDigits="10" action="${xmlEscape(url)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Please say or enter the correct phone number.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (correctionField === 'address') {
    const url = absoluteUrl(
      req,
      `/correctAppointmentAddress?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(url)}" method="POST" speechTimeout="auto" timeout="20">
    ${say("Please say the correct service address.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (correctionField === 'machine') {
    const url = absoluteUrl(
      req,
      `/correctAppointmentMachine?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(url)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Please say the correct machine.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (correctionField === 'issue') {
    const url = absoluteUrl(
      req,
      `/correctAppointmentIssue?machine=${encodeURIComponent(machine)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(url)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Please say the correct issue.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (correctionField === 'appointment') {
    const url = absoluteUrl(
      req,
      `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&startOffset=1&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
    );

    res.send(`
<Response>
  ${say("No problem. Let's choose a different appointment.")}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(url)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Press or say option 1, 2, or 3. You can also say next week or two weeks out.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
  }
}));

// ===== APPOINTMENT FIELD CORRECTION ROUTES =====
app.post('/correctAppointmentName', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const phone = req.query.phone || '';
  const address = req.query.address || '';
  const name = normalizeNameText(req.body.SpeechResult);

  res.type('text/xml');
  res.send(
    buildAppointmentConfirmationTwiml(req, {
      machine,
      issue,
      zip,
      serviceDate,
      serviceDay,
      serviceCounty,
      serviceWindow,
      name,
      phone,
      address
    })
  );
}));

app.post('/correctAppointmentAddress', wrapRoute(async (req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const rawAddress = String(req.body.SpeechResult || '').trim();
  const address = normalizeAddressForKnownZip(rawAddress, zip);

  const sameUrl = absoluteUrl(
    req,
    `/correctAppointmentAddress?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`
  );

  res.type('text/xml');

  if (!address || address.length < 5) {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(sameUrl)}" method="POST" speechTimeout="auto" timeout="20">
    ${say("I did not get the correct address. Please say the full service address again.")}
  </Gather>
  ${say("We did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(
    buildAppointmentConfirmationTwiml(req, {
      machine,
      issue,
      zip,
      serviceDate,
      serviceDay,
      serviceCounty,
      serviceWindow,
      name,
      phone,
      address
    })
  );
}));

app.post('/correctAppointmentMachine', wrapRoute((req, res) => {
  const currentMachine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = req.query.address || '';

  const machine = detectMachine(req.body.SpeechResult || '');
  const sameUrl = absoluteUrl(
    req,
    `/correctAppointmentMachine?machine=${encodeURIComponent(currentMachine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
  );

  res.type('text/xml');

  if (!machine) {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(sameUrl)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("I did not get the correct machine. Please say the machine again.")}
  </Gather>
  ${say("We did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(
    buildAppointmentConfirmationTwiml(req, {
      machine,
      issue,
      zip,
      serviceDate,
      serviceDay,
      serviceCounty,
      serviceWindow,
      name,
      phone,
      address
    })
  );
}));

app.post('/correctAppointmentIssue', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = req.query.address || '';
  const issue = normalizeIssueText(req.body.SpeechResult || 'Unknown');

  res.type('text/xml');
  res.send(
    buildAppointmentConfirmationTwiml(req, {
      machine,
      issue,
      zip,
      serviceDate,
      serviceDay,
      serviceCounty,
      serviceWindow,
      name,
      phone,
      address
    })
  );
}));

// ===== EMAIL CAPTURE FOR APPOINTMENTS =====
app.post('/getEmailForAppointment', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = req.query.address || '';
  const email = extractEmailFromSpeech(req);

  const sameUrl = absoluteUrl(
    req,
    `/getEmailForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
  );

  res.type('text/xml');

  if (!email || !email.includes('@')) {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(sameUrl)}" method="POST" speechTimeout="auto" timeout="15">
    ${say("I did not get the email address clearly. Please say it again.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(
    buildEmailConfirmationTwiml(req, {
      machine,
      issue,
      zip,
      serviceDate,
      serviceDay,
      serviceCounty,
      serviceWindow,
      name,
      phone,
      address,
      email
    })
  );
}));

app.post('/confirmAppointmentEmail', wrapRoute(async (req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  let serviceWindow = req.query.serviceWindow || '';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = req.query.address || '';
  const email = sanitizeLooseEmail(req.query.email || '');
  const decision = detectYesNoOrDigits(req);

  const retryUrl = absoluteUrl(
    req,
    `/getEmailForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
  );

  res.type('text/xml');

  if (decision !== 'yes') {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="15">
    ${say("Okay. Please say the email address again.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  const job = {
    id: generateJobId(),
    requestType: 'Appointment Request',
    name,
    machine,
    problem: issue,
    zip,
    phone,
    address,
    email,
    serviceDate,
    serviceDay,
    serviceCounty,
    serviceWindow,
    time: getEasternTimestamp()
  };

  saveJob(job);

  if (serviceDate && (serviceDay === 'Friday' || serviceDay === 'Saturday')) {
    await rebalanceFridaySaturdayJobs(serviceDate);
    const updatedJobs = loadJobs();
    const saved = updatedJobs.find((j) => j.id === job.id);
    if (saved) {
      serviceWindow = saved.serviceWindow || serviceWindow;
    }
  }

  console.log('JOB SAVED, PREPARING TO SEND EMAIL TO:', email);

  try {
    await sendAppointmentConfirmationEmail({
      to: email,
      name,
      machine,
      issue,
      serviceDate,
      serviceWindow,
      address
    });
  } catch (error) {
    console.error('Appointment email send failed:', error);
  }

  console.log('EMAIL SEND BLOCK FINISHED FOR:', email);

  const readableDate = getReadableDate(serviceDate);

  res.send(`
<Response>
  ${say("Great. You are all set.")}
  ${pause(1)}
  ${say(`I have booked your appointment for ${readableDate} between ${serviceWindow}.`)}
  ${pause(1)}
  ${say(`I have your email as ${formatEmailForSpeech(email)}.`)}
  ${pause(1)}
  ${say(`We look forward to helping with your ${machine}. Have a wonderful day.`)}
</Response>
`.trim());
}));

// ===== STEP 5D: FINAL APPOINTMENT CONFIRM =====
app.post('/finalConfirmAppointment', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = req.query.address || '';
  const decision = detectYesNoOrDigits(req);

  const correctionUrl = absoluteUrl(
    req,
    `/appointmentCorrectionChoice?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
  );

  const emailUrl = absoluteUrl(
    req,
    `/getEmailForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
  );

  res.type('text/xml');

  if (decision !== 'yes') {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(correctionUrl)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Okay. What needs to be corrected? You can say name, phone number, address, machine, issue, or appointment.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  ${say("Great.")}
  ${pause(1)}
  <Gather input="speech" action="${xmlEscape(emailUrl)}" method="POST" speechTimeout="auto" timeout="15">
    ${say("What email address would you like us to use for your appointment confirmation?")}
  </Gather>
  ${say("I did not catch that.")}
  <Gather input="speech" action="${xmlEscape(emailUrl)}" method="POST" speechTimeout="auto" timeout="15">
    ${say("Please say the email address you want us to use.")}
  </Gather>
  ${say("I still did not hear anything. Goodbye.")}
</Response>
`.trim());
}));

// ===== MESSAGE PATH =====
app.post('/getNameForMessage', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const name = normalizeNameText(req.body.SpeechResult);

  const phoneUrl = absoluteUrl(
    req,
    `/getPhoneForMessage?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}`
  );

  res.type('text/xml');
  res.send(`
<Response>
  ${say(`Thanks, ${name}.`)}
  ${pause(1)}
  <Gather input="speech dtmf" numDigits="10" action="${xmlEscape(phoneUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("What is the best phone number to reach you at? You can say it or enter it on your keypad.")}
  </Gather>
  ${say("We did not receive your phone number. Goodbye.")}
</Response>
`.trim());
}));

app.post('/getPhoneForMessage', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const name = req.query.name || 'Unknown';
  const phone = extractPhoneFromRequest(req);

  const retryPhoneUrl = absoluteUrl(
    req,
    `/getPhoneForMessage?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}`
  );

  const confirmPhoneUrl = absoluteUrl(
    req,
    `/confirmPhoneForMessage?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`
  );

  res.type('text/xml');

  if (!phone || phone.length < 10) {
    res.send(`
<Response>
  <Gather input="speech dtmf" numDigits="10" action="${xmlEscape(retryPhoneUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("I did not get the phone number. Please say it again or enter it using your keypad.")}
  </Gather>
  ${say("We did not receive your phone number. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  ${say(`I heard ${digitsToWords(phone)}.`)}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(confirmPhoneUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Is that correct? Please say yes or no. You can also press 1 for yes or 2 for no.")}
  </Gather>
  ${say("I did not catch that.")}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(confirmPhoneUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Please say yes if the phone number is correct, or say no to give it again. You can also press 1 for yes or 2 for no.")}
  </Gather>
  ${say("I still did not hear anything. Goodbye.")}
</Response>
`.trim());
}));

// ===== STEP 5B-2: MESSAGE PHONE CONFIRM =====
app.post('/confirmPhoneForMessage', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const decision = detectYesNoOrDigits(req);

  const phoneRetryUrl = absoluteUrl(
    req,
    `/getPhoneForMessage?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}`
  );

  const addressUrl = absoluteUrl(
    req,
    `/getAddressForMessage?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`
  );

  res.type('text/xml');

  if (decision !== 'yes') {
    res.send(`
<Response>
  <Gather input="speech dtmf" numDigits="10" action="${xmlEscape(phoneRetryUrl)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Okay. Please say or enter the phone number again.")}
  </Gather>
  ${say("We did not receive your phone number. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  ${say("Thanks.")}
  ${pause(1)}
  <Gather input="speech" action="${xmlEscape(addressUrl)}" method="POST" speechTimeout="auto" timeout="20">
    ${say("What is the service address? Please say the full street address.")}
  </Gather>
  ${say("We did not hear the address. Goodbye.")}
</Response>
`.trim());
}));

// ===== STEP 5C: MESSAGE ADDRESS =====
app.post('/getAddressForMessage', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = extractAddressFromSpeech(req);

  const retryUrl = absoluteUrl(
    req,
    `/getAddressForMessage?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`
  );

  res.type('text/xml');

  if (!address || address.length < 5) {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="20">
    ${say("I did not get the address. Please say the full service address again.")}
  </Gather>
  ${say("We still did not get the address. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(
    buildMessageConfirmationTwiml(req, {
      machine,
      issue,
      name,
      phone,
      address
    })
  );
}));

// ===== MESSAGE CORRECTION CHOICE =====
app.post('/messageCorrectionChoice', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = req.query.address || '';
  const correctionField = detectCorrectionField(req.body.SpeechResult || '');

  res.type('text/xml');

  if (!correctionField) {
    const retryUrl = absoluteUrl(
      req,
      `/messageCorrectionChoice?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Please tell me what needs to be corrected. You can say name, phone number, address, machine, or issue.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (correctionField === 'name') {
    const url = absoluteUrl(
      req,
      `/correctMessageName?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(url)}" method="POST" speechTimeout="4" timeout="10">
    ${say("Please say the correct first and last name.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (correctionField === 'phone') {
    const url = absoluteUrl(
      req,
      `/getPhoneForMessage?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}`
    );

    res.send(`
<Response>
  <Gather input="speech dtmf" numDigits="10" action="${xmlEscape(url)}" method="POST" speechTimeout="auto" timeout="10">
    ${say("Please say or enter the correct phone number.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (correctionField === 'address') {
    const url = absoluteUrl(
      req,
      `/correctMessageAddress?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(url)}" method="POST" speechTimeout="auto" timeout="20">
    ${say("Please say the correct service address.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (correctionField === 'machine') {
    const url = absoluteUrl(
      req,
      `/correctMessageMachine?issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(url)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Please say the correct machine.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (correctionField === 'issue') {
    const url = absoluteUrl(
      req,
      `/correctMessageIssue?machine=${encodeURIComponent(machine)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
    );

    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(url)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Please say the correct issue.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
  }
}));

// ===== MESSAGE FIELD CORRECTION ROUTES =====
app.post('/correctMessageName', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const phone = req.query.phone || '';
  const address = req.query.address || '';
  const name = normalizeNameText(req.body.SpeechResult);

  res.type('text/xml');
  res.send(
    buildMessageConfirmationTwiml(req, {
      machine,
      issue,
      name,
      phone,
      address
    })
  );
}));

app.post('/correctMessageAddress', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = extractAddressFromSpeech(req);

  const retryUrl = absoluteUrl(
    req,
    `/correctMessageAddress?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`
  );

  res.type('text/xml');

  if (!address || address.length < 5) {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="20">
    ${say("I did not get the correct address. Please say it again.")}
  </Gather>
  ${say("We did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(
    buildMessageConfirmationTwiml(req, {
      machine,
      issue,
      name,
      phone,
      address
    })
  );
}));

app.post('/correctMessageMachine', wrapRoute((req, res) => {
  const issue = req.query.issue || 'Unknown';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = req.query.address || '';
  const machine = detectMachine(req.body.SpeechResult || '');

  const retryUrl = absoluteUrl(
    req,
    `/correctMessageMachine?issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
  );

  res.type('text/xml');

  if (!machine) {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("I did not get the correct machine. Please say it again.")}
  </Gather>
  ${say("We did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(
    buildMessageConfirmationTwiml(req, {
      machine,
      issue,
      name,
      phone,
      address
    })
  );
}));

app.post('/correctMessageIssue', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = req.query.address || '';
  const issue = normalizeIssueText(req.body.SpeechResult || 'Unknown');

  res.type('text/xml');
  res.send(
    buildMessageConfirmationTwiml(req, {
      machine,
      issue,
      name,
      phone,
      address
    })
  );
}));

// ===== FINAL MESSAGE CONFIRM =====
app.post('/finalConfirmMessage', wrapRoute((req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const name = req.query.name || 'Unknown';
  const phone = req.query.phone || '';
  const address = req.query.address || '';
  const decision = detectYesNoOrDigits(req);

  const correctionUrl = absoluteUrl(
    req,
    `/messageCorrectionChoice?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&address=${encodeURIComponent(address)}`
  );

  res.type('text/xml');

  if (decision !== 'yes') {
    res.send(`
<Response>
  <Gather input="speech" action="${xmlEscape(correctionUrl)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Okay. What needs to be corrected? You can say name, phone number, address, machine, or issue.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  const job = {
    id: generateJobId(),
    requestType: 'Message',
    name,
    machine,
    problem: issue,
    phone,
    address,
    time: getEasternTimestamp()
  };

  saveJob(job);

  res.send(`
<Response>
  ${say("Thank you. Your message has been received. We will contact you shortly. Goodbye.")}
</Response>
`.trim());
}));

// ===== OUT OF AREA VOICEMAIL =====
app.post('/voicemail', wrapRoute((req, res) => {
  const matchedCounties = getCountyForZip(req.query.zip || '');

  const job = {
    id: generateJobId(),
    requestType: 'Out Of Area Voicemail',
    name: req.query.name || 'Unknown',
    machine: req.query.machine || 'Unknown',
    problem: req.query.issue || 'Unknown',
    zip: req.query.zip || 'Unknown',
    serviceCounty: matchedCounties.join(', '),
    recording: req.body.RecordingUrl || '',
    time: getEasternTimestamp()
  };

  saveJob(job);

  res.type('text/xml');
  res.send(`
<Response>
  ${say("Thank you. Your message has been recorded. Goodbye.")}
</Response>
`.trim());
}));

// ===== JOBS PAGE =====
app.get('/jobs', async (req, res) => {
  const jobs = loadJobs();

  // Enrich appointment jobs with distance info
  const enrichedJobs = await Promise.all(jobs.map(async (job) => {
    if (job.requestType === 'Appointment Request' && job.zip) {
      const miles = await getDistanceFromHomeMiles(job.zip);
      const isFar = miles > 10;
      return { ...job, miles: Math.round(miles * 10) / 10, isFar };
    }
    return { ...job, miles: null, isFar: null };
  }));

  // Build route stop numbers per service date
  // Group by serviceDate, sort by window (morning first) then distance
  const byDate = {};
  enrichedJobs.forEach(job => {
    if (job.requestType === 'Appointment Request' && job.serviceDate) {
      if (!byDate[job.serviceDate]) byDate[job.serviceDate] = [];
      byDate[job.serviceDate].push(job);
    }
  });

  const stopNumbers = {};
  Object.entries(byDate).forEach(([date, dateJobs]) => {
    const morningWindow = routingConfig.fridaySaturdayMorningWindow;
    const morning = dateJobs.filter(j => j.serviceWindow === morningWindow).sort((a, b) => (a.miles || 0) - (b.miles || 0));
    const other = dateJobs.filter(j => j.serviceWindow !== morningWindow).sort((a, b) => (a.miles || 0) - (b.miles || 0));
    [...morning, ...other].forEach((job, i) => {
      stopNumbers[job.id] = i + 1;
    });
  });

  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="10">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RL Jobs</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 16px;
      background: #ffffff;
      color: #111111;
    }
    h1 { margin-bottom: 8px; }
    .refresh-note { color: #666666; font-size: 14px; margin-bottom: 16px; }
    .job {
      border: 1px solid #cccccc;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .job strong { font-size: 18px; }
    .line { margin-top: 4px; }
    .stop { font-size: 13px; font-weight: bold; color: #ffffff; background: #1a73e8; border-radius: 4px; padding: 2px 8px; display: inline-block; margin-bottom: 6px; }
    .near { color: #1e7e34; font-weight: bold; }
    .far { color: #c0392b; font-weight: bold; }
    a { color: #0b57d0; }
  </style>
</head>
<body>
  <h1>Jobs</h1>
  <div class="refresh-note">Auto-refreshing every 10 seconds</div>
`;

  if (enrichedJobs.length === 0) {
    html += '<p>No jobs yet</p>';
    html += '</body></html>';
    res.send(html);
    return;
  }

  enrichedJobs.forEach((job) => {
    const stop = stopNumbers[job.id];
    const milesLabel = job.miles !== null ? `${job.miles} mi from home` : '';
    const nearFarLabel = job.isFar !== null
      ? (job.isFar ? `<span class="far">FAR</span>` : `<span class="near">NEAR</span>`)
      : '';

    html += `
  <div class="job">
    ${stop ? `<div class="stop">Stop ${stop}</div>` : ''}
    <strong>${job.time || ''}</strong>
    <div class="line">Type: ${job.requestType || ''}</div>
    <div class="line">Name: ${job.name || ''}</div>
    <div class="line">Machine: ${job.machine || ''}</div>
    <div class="line">Problem: ${job.problem || ''}</div>
    ${job.zip ? `<div class="line">ZIP: ${job.zip}${milesLabel ? ` &nbsp;·&nbsp; ${milesLabel}` : ''}${nearFarLabel ? ` &nbsp;·&nbsp; ${nearFarLabel}` : ''}</div>` : ''}
    ${job.phone ? `<div class="line">Phone: ${job.phone}</div>` : ''}
    ${job.address ? `<div class="line">Address: ${job.address}</div>` : ''}
    ${job.email ? `<div class="line">Email: ${job.email}</div>` : ''}
    ${job.serviceDate ? `<div class="line">Service Date: ${job.serviceDate}</div>` : ''}
    ${job.serviceDay ? `<div class="line">Service Day: ${job.serviceDay}</div>` : ''}
    ${job.serviceCounty ? `<div class="line">County: ${job.serviceCounty}</div>` : ''}
    ${job.serviceWindow ? `<div class="line">Window: ${job.serviceWindow}</div>` : ''}
    ${job.recording ? `<div class="line">Recording: <a href="${job.recording}" target="_blank">Listen</a></div>` : ''}
  </div>
`;
  });

  html += `
</body>
</html>
`;

  res.send(html);
});

app.use((err, req, res, next) => {
  console.error('Unhandled app error:', err);
  if (!res.headersSent) {
    res.type('text/xml');
    res.status(200).send(buildSafeErrorTwiml());
    return;
  }
  next(err);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });

const wss = new WebSocket.Server({ server });

function getNextDateForDay(dayName) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const target = days.indexOf(dayName);
  if (target === -1) return null;
  const now = getEasternNow();
  const current = now.getDay();
  let diff = target - current;
  if (diff <= 0) diff += 7;
  const next = new Date(now);
  next.setDate(now.getDate() + diff);
  return formatEasternDateKey(next);
}

function rejoinSpacedDigits(text) {
  return String(text || '')
    .replace(/(\b\d{1,2}\s){1,}\d{1,2}\b/g, (match) => match.replace(/\s/g, ''));
}

function formatStreetNumberForSpeech(address) {
  return String(address || '').replace(/^(\d+)/, (num) => {
    if (num.length === 4) return num.slice(0,2) + ' ' + num.slice(2);
    if (num.length === 3) return num.slice(0,1) + ' ' + num.slice(1);
    return num;
  });
}

function detectYesNoText(text) {
  const c = cleanText(text);
  if (c.includes('yes') || c.includes('correct') || c.includes('that is correct') || c.includes('sounds correct')) return 'yes';
  if (c.includes('no') || c.includes('wrong') || c.includes('not correct') || c.includes('change it')) return 'no';
  return '';
}

function getFirstName(fullName) {
  const parts = String(fullName || '').trim().split(/s+/).filter(Boolean);
  return parts[0] || String(fullName || '').trim();
}

function detectMachineFast(input) {
  const cleaned = cleanText(applyLocalCorrections(input));

  if (cleaned.includes('riding mower') || cleaned.includes('ride on mower') || cleaned.includes('rider mower')) {
    return 'Riding mower';
  }

  if (cleaned.includes('lawn tractor') || cleaned.includes('tractor mower')) {
    return 'Riding mower';
  }

  return detectMachine(input);
}

wss.on('connection', (ws, req) => {
  console.log('ConversationRelay connected');
  const callState = {
    machine: '', machineSpoken: '', issue: '', zip: '', awaitingZipConfirmation: false,
    zipConfirmed: false, serviceable: false, askedForSchedule: false, inScheduling: false,
    offeredSlots: [], selectedSlot: null,
    timeWindow: '', serviceDate: '', callerName: '', phone: null,
    phoneConfirmed: false, address: null, addressConfirmed: false,
    email: null, emailConfirmed: false, awaitingEmail: false, booked: false,
    askedLastStarted: false, lastStartedAnswer: '', issueNeedsLastStarted: false,
    issueNeedsTuneUpClarification: false, gaveTuneUpClarification: false,
    pendingIssue: null, pendingIssueNeedsLastStarted: false,
    callEnded: false
  };

  // Helper: keep live call flow fast and predictable.
  // Do not call AI during live turn-by-turn flow; use the scripted fallback line.
  async function emmaReply(callerSaid, instruction, fallback) {
    ws.send(JSON.stringify({ type: 'text', token: fallback, last: true }));
  }

  // Helper kept for compatibility, but it no longer sends filler or waits on AI.
  async function emmaReplyWithFiller(filler, callerSaid, instruction, fallback) {
    ws.send(JSON.stringify({ type: 'text', token: fallback, last: true }));
  }

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      switch (data.type) {
        case 'setup':
          console.log('ConversationRelay setup');
          break;
        case 'prompt': {
          const userText = data.voicePrompt || '';
          const cleaned = cleanText(userText);
          const text = userText.toLowerCase();

          console.log('Caller said:', userText);

          if (callState.callEnded) break;

          // ===== COMMERCIAL EQUIPMENT FILTER =====
          {
            const commercialKeywords = config.commercialKeywords || [
              'commercial', 'stand on', 'stand-on', 'standon', 'pro series',
              'zero turn commercial', 'heavy duty', 'industrial', 'fleet'
            ];
            const isCommercial = commercialKeywords.some(kw => cleaned.includes(kw) || text.includes(kw));
            if (isCommercial) {
              ws.send(JSON.stringify({ type: 'text', token: 'Sorry, we only service residential equipment. Goodbye.', last: true }));
              callState.callEnded = true;
              setTimeout(() => { try { ws.close(); } catch (e) {} }, 4000);
              break;
            }
          }

          // ===== SILENT STATE EXTRACTION =====
          // Run fast extractors on every turn to silently fill in state.

          // Machine
          if (!callState.machine) {
            const m = detectMachineFast(userText);
            if (m) {
              callState.machine = m;
              if (!callState.machineSpoken) {
                if (cleaned.includes('lawn tractor') || cleaned.includes('tractor')) {
                  callState.machineSpoken = 'lawn tractor';
                } else {
                  callState.machineSpoken = m.toLowerCase();
                }
              }
              if (callState.pendingIssue && !callState.issue) {
                callState.issue = callState.pendingIssue;
                if (callState.pendingIssueNeedsLastStarted) callState.issueNeedsLastStarted = true;
                callState.pendingIssue = null;
                callState.pendingIssueNeedsLastStarted = false;
              } else {
                const mc = cleanText(m);
                const stripped = cleaned.replace(mc, '').trim();
                if (stripped.length > 0 && !callState.issue) {
                  const hasSymptom = config.symptomKeywords.some(kw => stripped.includes(kw));
                  const isNoStart = stripped.includes("won't start") || stripped.includes('wont start') ||
                    stripped.includes('will not start') || stripped.includes('not starting') || stripped.includes('no start');
                  if (hasSymptom || isNoStart) {
                    callState.issue = userText.trim();
                    if (isNoStart) callState.issueNeedsLastStarted = true;
                  } else {
                    callState.pendingIssue = userText.trim();
                    callState.pendingIssueNeedsLastStarted = isNoStart;
                  }
                }
              }
              console.log('[CALLSTATE] machine:', callState.machine, '| issue:', callState.issue);
            }
          }

          // Issue
          if (!callState.issue) {
            const hasSymptomKeyword = config.symptomKeywords.some(kw => cleaned.includes(kw));
            const hasVagueIssue = config.vagueIssuePhrases.some(p => cleaned.includes(p));
            const machineOnly = (config.machineOnlyWords || []).some(w => cleaned === w || cleaned.replace(/\s+/g,' ').trim() === w);
            const isNoStartIssue = cleaned.includes('not starting') || cleaned.includes('won t start') ||
              cleaned.includes('wont start') || cleaned.includes('no start') || cleaned.includes('doesn t start');
            const wantsTuneUpButBroken =
              (cleaned.includes('tune up') || cleaned.includes('tuneup')) &&
              (cleaned.includes("won't start") || cleaned.includes('wont start') || cleaned.includes('not starting') ||
               cleaned.includes('no start') || cleaned.includes('shut off') || cleaned.includes('stall') || cleaned.includes('dies'));

            if (wantsTuneUpButBroken) {
              callState.issue = userText.trim();
              callState.issueNeedsTuneUpClarification = true;
              console.log('[CALLSTATE] tune-up + broken captured:', callState.issue);
            } else if (!machineOnly && !hasVagueIssue && hasSymptomKeyword) {
              callState.issue = userText.trim();
              if (isNoStartIssue) callState.issueNeedsLastStarted = true;
              console.log('[CALLSTATE] issue captured:', callState.issue);
            }
          }

          // ZIP (silent extraction — only when we're in scheduling or they gave it proactively)
          if (!callState.zipConfirmed) {
            const possibleZip = normalizeSpokenDigits(text).slice(0, 5);
            if (possibleZip.length === 5 && getCountyForZip(possibleZip).length > 0) {
              if (!callState.zip || callState.zip !== possibleZip) {
                callState.zip = possibleZip;
                callState.awaitingZipConfirmation = true;
                console.log('[CALLSTATE] zip captured silently:', callState.zip);
              }
            }
          }

          // ===== EARLY "DO YOU SERVICE" QUESTIONS =====
          if (!callState.inScheduling && !callState.callerName) {
            const isEquipmentQuestion =
              text.includes('do you work on') || text.includes('do you fix') ||
              text.includes('do you repair') || text.includes('do you service');
            const isAreaQuestion =
              text.includes('what area') || text.includes('service my area') ||
              text.includes('service that area') || text.includes('cover zip') ||
              text.includes('do you service zip') || text.includes('do you cover');

            if (isEquipmentQuestion && !callState.machine) {
              let detected = null;
              for (const m of config.machineTypes) {
                for (const kw of m.keywords) {
                  if (text.includes(kw)) { detected = m.name; break; }
                }
                if (detected) break;
              }
              if (detected) {
                callState.machine = detected;
                if (!callState.machineSpoken) {
                  if (cleaned.includes('lawn tractor') || cleaned.includes('tractor')) {
                    callState.machineSpoken = 'lawn tractor';
                  } else {
                    callState.machineSpoken = detected.toLowerCase();
                  }
                }
                await emmaReply(userText,
                  `Tell the caller yes we work on ${detected}s and ask what it's doing or not doing.`,
                  `Yes, we work on those. What is it doing or not doing?`);
              } else {
                ws.send(JSON.stringify({ type: 'text', token: "Sorry, we don't work on that equipment. Goodbye.", last: true }));
                callState.callEnded = true;
                setTimeout(() => { try { ws.close(); } catch (e) {} }, 4000);
              }
              break;
            }

            if (isAreaQuestion && callState.zipConfirmed) {
              if (callState.serviceable) {
                await emmaReply(userText, 'Tell the caller yes we service their area and ask what equipment they need help with if not known, or ask if they want to schedule if machine and issue are known.', 'Yeah, we do service that area.');
              } else {
                ws.send(JSON.stringify({ type: 'text', token: "Sorry, we don't service that area. Goodbye.", last: true }));
                callState.callEnded = true;
                setTimeout(() => { try { ws.close(); } catch (e) {} }, 4000);
              }
              break;
            }
          }

          // ===== ZIP CONFIRMATION =====
          if (callState.awaitingZipConfirmation && callState.zipConfirmed) {
            callState.awaitingZipConfirmation = false;
          }

          if (callState.awaitingZipConfirmation) {
            const dec = detectYesNoText(userText);
            if (dec === 'yes') {
              callState.awaitingZipConfirmation = false;
              callState.zipConfirmed = true;
              const counties = getCountyForZip(callState.zip);
              if (!counties.length) {
                ws.send(JSON.stringify({ type: 'text', token: `Sorry, we don't service zip code ${callState.zip}. Goodbye.`, last: true }));
                callState.callEnded = true;
                setTimeout(() => { try { ws.close(); } catch (e) {} }, 4000);
                break;
              }
              callState.serviceable = true;
              if (callState.inScheduling) {
                const slots = await findAvailableSlots(callState.zip, 1, 1);
                callState.offeredSlots = slots;
                const avail = slots.length ? `Great. ${buildAvailabilitySpeech(slots)}` : 'We service that area but have no openings right now. Please call back soon.';
                ws.send(JSON.stringify({ type: 'text', token: avail, last: true }));
              } else {
                await emmaReply(userText,
                  `Tell the caller we service their area and move the conversation forward. ${callState.machine && callState.issue ? 'Ask if they want to schedule.' : callState.machine ? 'Ask what the problem is.' : 'Ask what equipment they need help with.'}`,
                  'Great, we do service that area.');
              }
            } else if (dec === 'no') {
              callState.awaitingZipConfirmation = false;
              callState.zip = '';
              ws.send(JSON.stringify({ type: 'text', token: 'Okay, what is your five digit ZIP code?', last: true }));
            } else {
              ws.send(JSON.stringify({ type: 'text', token: `I heard ZIP code ${callState.zip}. Is that correct?`, last: true }));
            }
            break;
          }

          // ===== TUNE-UP MISCONCEPTION =====
          if (callState.issueNeedsTuneUpClarification && !callState.gaveTuneUpClarification) {
            callState.gaveTuneUpClarification = true;
            await emmaReply(userText,
              `The caller thinks a tune-up will fix their ${callState.machine || 'machine'} but it won't start. Gently correct them — if it won't start it likely needs more than a tune-up — and ask when it last ran.`,
              `If it won't start, it may need more than a tune-up. When was the last time it ran?`);
            break;
          }

          // ===== LAST STARTED FOLLOW-UP =====
          if (callState.issueNeedsLastStarted && !callState.askedLastStarted) {
            callState.askedLastStarted = true;
            await emmaReply(userText,
              `Acknowledge the ${callState.machine || 'machine'} won't start and ask when it last ran. One sentence.`,
              `Okay, it won't start. When was the last time it ran?`);
            break;
          }

          if (callState.askedLastStarted && !callState.lastStartedAnswer) {
            callState.lastStartedAnswer = userText.trim();
            console.log('[CALLSTATE] lastStartedAnswer:', callState.lastStartedAnswer);
            if (!callState.askedForSchedule) {
              callState.askedForSchedule = true;
              await emmaReply(userText,
                `Acknowledge what they said about when it last ran, then ask if they want to schedule an appointment.`,
                `Thanks. Would you like to schedule a time for us to come take a look?`);
            }
            break;
          }

          // ===== NO MACHINE YET =====
          if (!callState.machine) {
            await emmaReply(userText,
              `The machine type is not yet known. Ask what type of equipment they need help with. One sentence.`,
              `What kind of equipment do you need help with?`);
            break;
          }

          // ===== MACHINE KNOWN, NO ISSUE =====
          if (callState.machine && !callState.issue) {
            await emmaReply(userText,
              `Machine is ${callState.machine}. Acknowledge it and ask what it's doing or not doing. One sentence.`,
              `Got it — ${callState.machineSpoken || callState.machine.toLowerCase()}. What is it doing or not doing?`);
            break;
          }

          // ===== ASK TO SCHEDULE =====
          if (callState.machine && callState.issue && !callState.askedForSchedule && !callState.inScheduling) {
            callState.askedForSchedule = true;
            await emmaReply(userText,
              `Machine is ${callState.machine}, issue is noted. Briefly acknowledge and ask if they want to schedule an appointment.`,
              `Would you like to schedule a time for us to come take a look?`);
            break;
          }

          // ===== SCHEDULE DECISION =====
          if (callState.askedForSchedule && !callState.inScheduling) {
            const yesWords = ['yes', 'yeah', 'yep', 'schedule', 'set it up', 'book it', 'book', 'sure', 'please', 'okay', 'let s go'];
            const noWords = ['no', 'not right now', 'just calling', 'just checking', 'maybe later', 'not yet'];
            if (yesWords.some(w => text.includes(w))) {
              callState.inScheduling = true;
              if (callState.zipConfirmed) {
                const slots = await findAvailableSlots(callState.zip, 1, 1);
                callState.offeredSlots = slots;
                const avail = slots.length ? buildAvailabilitySpeech(slots) : 'Sorry, no openings right now. Please call back soon.';
                ws.send(JSON.stringify({ type: 'text', token: avail, last: true }));
              } else {
                ws.send(JSON.stringify({ type: 'text', token: 'What is your five digit ZIP code?', last: true }));
              }
            } else if (noWords.some(w => text.includes(w))) {
              await emmaReply(userText,
                `Caller doesn't want to schedule right now. Politely wrap up — let them know they can call back anytime.`,
                `No problem — feel free to call back whenever you're ready. Have a good one.`);
              callState.callEnded = true;
              setTimeout(() => { try { ws.close(); } catch (e) {} }, 6000);
            } else {
              await emmaReply(userText,
                `Not sure if caller wants to schedule. Ask again clearly — do they want to schedule an appointment?`,
                `Would you like to schedule a time for us to come take a look?`);
            }
            break;
          }

          // ===== COLLECT ZIP (scheduling in progress) =====
          if (callState.inScheduling && !callState.zipConfirmed) {
            const possibleZip = normalizeSpokenDigits(userText).slice(0, 5);
            if (possibleZip.length === 5) {
              callState.zip = possibleZip;
              callState.awaitingZipConfirmation = true;
              ws.send(JSON.stringify({ type: 'text', token: `I heard ZIP code ${callState.zip}. Is that correct?`, last: true }));
            } else {
              ws.send(JSON.stringify({ type: 'text', token: 'What is your five digit ZIP code?', last: true }));
            }
            break;
          }

          // ===== SHOW AVAILABILITY =====
          if (callState.zipConfirmed && callState.inScheduling && !callState.offeredSlots.length) {
            const slots = await findAvailableSlots(callState.zip, 1, 1);
            callState.offeredSlots = slots;
            const avail = slots.length ? buildAvailabilitySpeech(slots) : 'No openings right now. Please call back soon.';
            ws.send(JSON.stringify({ type: 'text', token: avail, last: true }));
            break;
          }

          // ===== SLOT SELECTION =====
          if (callState.inScheduling && callState.offeredSlots.length && !callState.selectedSlot) {
            const tempReq = { body: { SpeechResult: userText, Digits: '' } };
            let chosen = detectNaturalSlot(tempReq, callState.offeredSlots);
            const yesToOnlyOption = detectYesNoText(userText) === 'yes' && callState.offeredSlots.length === 1;
            if (!chosen && yesToOnlyOption) {
              chosen = callState.offeredSlots[0];
            }
            const noToOfferedAppointment = detectYesNoText(userText) === 'no';
            const noneWork = noToOfferedAppointment || cleaned.includes('none') || cleaned.includes('neither') ||
              cleaned.includes('not available') || cleaned.includes('don t work') ||
              cleaned.includes('dont work') || cleaned.includes('something else') ||
              cleaned.includes('different') || cleaned.includes('other');

            if (!chosen && noneWork) {
              const lastSlot = callState.offeredSlots[callState.offeredSlots.length - 1];
              let nextOffset = 8;
              if (lastSlot) {
                const todayKey = formatEasternDateKey(getEasternNow());
                const today = new Date(`${todayKey}T12:00:00`);
                const last = new Date(`${lastSlot.serviceDate}T12:00:00`);
                nextOffset = Math.max(1, Math.ceil((last - today) / (1000 * 60 * 60 * 24)) + 1);
              }

              const moreSlots = await findAvailableSlots(callState.zip, nextOffset, 1);
              if (moreSlots.length) {
                callState.offeredSlots = moreSlots;
                const nextPhrase = formatSlotPhrase(moreSlots[0]);
                ws.send(JSON.stringify({
                  type: 'text',
                  token: `No problem. The next available for your ZIP code is ${nextPhrase}. Does that work for you?`,
                  last: true
                }));
              } else {
                ws.send(JSON.stringify({ type: 'text', token: 'I do not see another opening for that ZIP code right now. Please call back soon.', last: true }));
              }
              break;
            }

            if (!chosen) {
              ws.send(JSON.stringify({ type: 'text', token: callState.offeredSlots.length === 1 ? 'Please say yes if that appointment works, or no if you want the next available date for your ZIP code.' : 'Which option works for you? You can say the day, or morning or afternoon.', last: true }));
              break;
            }

            callState.selectedSlot = chosen;
            callState.timeWindow = chosen.serviceWindow;
            callState.serviceDate = chosen.serviceDate;
            await emmaReply(userText,
              `Caller chose ${chosen.readableDate} ${chosen.serviceWindow}. Confirm it and ask for their first and last name.`,
              `Okay, ${chosen.readableDate}, from ${chosen.serviceWindow}. Can I get your first and last name?`);
            break;
          }

          // ===== NAME =====
          if (callState.selectedSlot && !callState.callerName) {
            callState.callerName = normalizeNameText(userText);
            const spokenFirstName = getFirstName(callState.callerName);
            await emmaReply(userText,
              `Caller's name is ${callState.callerName}. Acknowledge it using first name only and ask for the best phone number to reach them.`,
              `Thanks, ${spokenFirstName}. What is the best phone number to reach you?`);
            break;
          }

          // ===== PHONE =====
          if (callState.callerName && !callState.phone) {
            const phone = normalizeTenDigitPhone(normalizeSpokenDigits(userText));
            if (!phone) {
              ws.send(JSON.stringify({ type: 'text', token: "I didn't catch that — can you say the phone number again?", last: true }));
              break;
            }
            callState.phone = phone;
            callState.phoneConfirmed = false;
            ws.send(JSON.stringify({ type: 'text', token: `I have ${digitsToWords(phone)}. Is that correct?`, last: true }));
            break;
          }

          if (callState.phone && !callState.phoneConfirmed) {
            const dec = detectYesNoText(userText);
            if (dec === 'yes') {
              callState.phoneConfirmed = true;
              ws.send(JSON.stringify({ type: 'text', token: 'What is the service address? Please say the full street address.', last: true }));
            } else if (dec === 'no') {
              callState.phone = null;
              ws.send(JSON.stringify({ type: 'text', token: 'Okay. What is the best phone number to reach you?', last: true }));
            } else {
              ws.send(JSON.stringify({ type: 'text', token: `I have ${digitsToWords(callState.phone)}. Is that correct?`, last: true }));
            }
            break;
          }

          // ===== ADDRESS =====
          if (callState.phoneConfirmed && !callState.address) {
            callState.address = normalizeAddressForKnownZip(userText, callState.zip);
            if (!callState.address) {
              ws.send(JSON.stringify({ type: 'text', token: 'Could you say the full street address again?', last: true }));
              break;
            }
            callState.addressConfirmed = false;
            ws.send(JSON.stringify({ type: 'text', token: `I heard ${formatAddressForSpeech(callState.address)}. Is that correct?`, last: true }));
            break;
          }

          if (callState.address && !callState.addressConfirmed) {
            const dec = detectYesNoText(userText);
            if (dec === 'yes') {
              callState.addressConfirmed = true;
              callState.awaitingEmail = true;
              ws.send(JSON.stringify({ type: 'text', token: 'What email address should we send the confirmation to?', last: true }));
            } else if (dec === 'no') {
              callState.address = null;
              ws.send(JSON.stringify({ type: 'text', token: 'Okay. What is the service address? Please say the full street address.', last: true }));
            } else {
              ws.send(JSON.stringify({ type: 'text', token: `I heard ${formatAddressForSpeech(callState.address)}. Is that correct?`, last: true }));
            }
            break;
          }

          // ===== EMAIL =====
          if (callState.addressConfirmed && !callState.email && !callState.awaitingEmail) {
            callState.awaitingEmail = true;
            ws.send(JSON.stringify({ type: 'text', token: 'What email address should we send the confirmation to?', last: true }));
            break;
          }

          if (callState.awaitingEmail && !callState.email) {
            const email = fallbackExtractEmail(userText);
            if (!email) {
              ws.send(JSON.stringify({ type: 'text', token: "I didn't get that clearly — can you say the email again slowly?", last: true }));
              break;
            }
            callState.email = email;
            callState.awaitingEmail = false;
            callState.emailConfirmed = false;
            ws.send(JSON.stringify({ type: 'text', token: `I have ${formatEmailForSpeech(callState.email)}. Is that correct?`, last: true }));
            break;
          }

          if (callState.email && !callState.emailConfirmed) {
            const dec = detectYesNoText(userText);
            if (dec === 'yes') {
              callState.emailConfirmed = true;
              const job = {
                id: generateJobId(),
                requestType: 'Appointment Request',
                name: callState.callerName,
                machine: callState.machine,
                problem: callState.issue,
                zip: callState.zip,
                phone: callState.phone,
                address: callState.address,
                email: callState.email,
                serviceDate: callState.serviceDate,
                serviceDay: getDayNameInEastern(new Date(`${callState.serviceDate}T12:00:00`)),
                serviceCounty: getCountyForZip(callState.zip)[0] || '',
                serviceWindow: callState.timeWindow,
                lastStarted: callState.lastStartedAnswer || '',
                time: getEasternTimestamp()
              };
              saveJob(job);
              await rebalanceFridaySaturdayJobs(callState.serviceDate);
              try {
                await sendAppointmentConfirmationEmail({
                  to: callState.email,
                  name: callState.callerName,
                  machine: callState.machine,
                  issue: callState.issue,
                  serviceDate: callState.serviceDate,
                  serviceWindow: callState.timeWindow,
                  address: callState.address
                });
              } catch (e) {
                console.error('Email send failed:', e);
              }
              ws.send(JSON.stringify({
                type: 'text',
                token: `You're all set for ${getReadableDate(callState.serviceDate)}, from ${callState.timeWindow}. Confirmation is on its way to that email. We look forward to helping with your ${callState.machineSpoken || callState.machine.toLowerCase()}. Goodbye.`,
                last: true
              }));
              callState.callEnded = true;
              setTimeout(() => { try { ws.close(); } catch (e) {} }, 25000);
            } else if (dec === 'no') {
              callState.email = null;
              callState.awaitingEmail = true;
              ws.send(JSON.stringify({ type: 'text', token: 'Okay, go ahead and say the email address again.', last: true }));
            } else {
              ws.send(JSON.stringify({ type: 'text', token: `I have ${formatEmailForSpeech(callState.email)}. Is that correct?`, last: true }));
            }
            break;
          }

          // ===== FALLBACK =====
          await emmaReply(userText,
            `Not sure what the caller needs. Acknowledge them and gently ask how you can help or move the conversation forward.`,
            `Sorry, could you say that again?`);
          break;
        }
      }
    } catch (err) {
      console.error('ConversationRelay error:', err);
      try {
        ws.send(JSON.stringify({ type: 'text', token: 'Sorry, something went wrong on our end. Goodbye.', last: true }));
        setTimeout(() => { try { ws.close(); } catch (e) {} }, 3000);
      } catch (e) {}
    }
  });
});
