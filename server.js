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
    throw new Error(data.error?.message || 'OpenAI request failed');
  }

  const aiText = parseGPTResponseText(data);
  return aiText || 'Okay, tell me a little more about that.';
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

  // Step 3: If both agree or only one produced a result, use what we have
  if (!gptDirect && !regexResult) return '';
  if (!gptDirect) return regexResult;
  if (!regexResult) return gptDirect;
  if (gptDirect === regexResult) return gptDirect;

  // Step 4: They differ — ask GPT to pick the best one
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

function buildAvailabilitySpeech(slots) {
  if (!slots || !slots.length) {
    return 'There are no available appointments right now.';
  }

  const monThu = slots.filter(s =>
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday'].includes(s.serviceDay)
  );

  const friday = slots.filter(s => s.serviceDay === 'Friday');
  const saturday = slots.filter(s => s.serviceDay === 'Saturday');

  let speechParts = [];

  // MON-THU
  if (monThu.length) {
    const days = monThu.map(s => s.serviceDay);
    const dates = monThu.map(s => formatDateShort(s.serviceDate));
    const firstDay = days[0];
    const lastDay = days[days.length - 1];
    const rangeText = firstDay === lastDay ? firstDay : `${firstDay} through ${lastDay}`;
    speechParts.push(
      `We have ${rangeText} from 10:00 to 10:30. Available dates are ${dates.join(', ')}.`
    );
  }

  // FRIDAY
  if (friday.length) {
    const date = formatDateShort(friday[0].serviceDate);
    const hasMorning = friday.some(s => s.serviceWindow === '10:00 to 12:00');
    const hasAfternoon = friday.some(s => s.serviceWindow === '1:00 to 4:00');
    if (hasMorning && hasAfternoon) {
      speechParts.push(`Friday, ${date}, has morning from 10:00 to 12:00 and afternoon from 1:00 to 4:00.`);
    } else if (hasMorning) {
      speechParts.push(`Friday, ${date}, has morning from 10:00 to 12:00 available.`);
    } else if (hasAfternoon) {
      speechParts.push(`Friday, ${date}, has afternoon from 1:00 to 4:00 available.`);
    }
  }

  // SATURDAY
  if (saturday.length) {
    const date = formatDateShort(saturday[0].serviceDate);
    const hasMorning = saturday.some(s => s.serviceWindow === '10:00 to 12:00');
    const hasAfternoon = saturday.some(s => s.serviceWindow === '1:00 to 4:00');
    if (hasMorning && hasAfternoon) {
      speechParts.push(`Saturday, ${date}, has morning from 10:00 to 12:00 and afternoon from 1:00 to 4:00.`);
    } else if (hasMorning) {
      speechParts.push(`Saturday, ${date}, has morning from 10:00 to 12:00 available.`);
    } else if (hasAfternoon) {
      speechParts.push(`Saturday, ${date}, has afternoon from 1:00 to 4:00 available.`);
    }
  }

  return `${speechParts.join(' ')} What works best for you?`;
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

async function normalizeAddressForKnownZip(rawAddress, expectedZip) {
  const normalized = normalizeAddressText(rawAddress || '');

  if (!expectedZip) {
    return normalized;
  }

  const place = await getZipPlaceInfo(expectedZip);
  const streetOnly = removeKnownLocationSuffix(normalized, place, expectedZip) || removeTrailingZipOnly(normalized, expectedZip) || normalized;

  if (!place || !place.city) {
    return `${streetOnly} ${expectedZip}`.replace(/\s+/g, ' ').trim();
  }

  const fullState = place.state || 'Maryland';
  return `${streetOnly} ${place.city} ${fullState} ${expectedZip}`.replace(/\s+/g, ' ').trim();
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

  const enriched = [];
  for (const job of dayJobs) {
    const distance = await getDistanceFromHomeMiles(job.zip);
    enriched.push({ job, distance });
  }

  enriched.sort((a, b) => a.distance - b.distance);

  for (let i = 0; i < enriched.length; i += 1) {
    const current = enriched[i].job;

    if (i < routingConfig.fridaySaturdayMorningMax) {
      current.serviceWindow = routingConfig.fridaySaturdayMorningWindow;
    } else if (
      i <
      routingConfig.fridaySaturdayMorningMax +
        routingConfig.fridaySaturdayAfternoonMax
    ) {
      current.serviceWindow = routingConfig.fridaySaturdayAfternoonWindow;
    } else {
      current.serviceWindow = 'We will contact you to schedule your service window.';
    }
  }

  saveAllJobs(jobs);
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

    if (
      dayJobs.length <
      routingConfig.fridaySaturdayMorningMax +
        routingConfig.fridaySaturdayAfternoonMax
    ) {
      const tempCandidate = { id: '__temp__', zip };
      const compareList = dayJobs.map((job) => ({ id: job.id, zip: job.zip }));
      compareList.push(tempCandidate);

      const enriched = [];
      for (const item of compareList) {
        const distance = await getDistanceFromHomeMiles(item.zip);
        enriched.push({ ...item, distance });
      }

      enriched.sort((a, b) => a.distance - b.distance);
      const tempIndex = enriched.findIndex((item) => item.id === '__temp__');

      const serviceWindow =
        tempIndex < routingConfig.fridaySaturdayMorningMax
          ? routingConfig.fridaySaturdayMorningWindow
          : routingConfig.fridaySaturdayAfternoonWindow;

      return {
        serviceDate,
        serviceDay: dayName,
        serviceCounty: matchedAllowed,
        serviceWindow
      };
    }

    return null;
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

    // For Fri/Sat, add both morning and afternoon slots if available
    if ((dayName === 'Friday' || dayName === 'Saturday') && !seenDates.has(serviceDate)) {
      const allowed = dayName === 'Friday' ? routingConfig.fridayAllowedCounties : routingConfig.saturdayAllowedCounties;
      const matchedAllowed = matchingCounties.find(c => allowed.includes(c));
      if (matchedAllowed) {
        const dayJobs = getAppointmentJobsForDate(loadJobs(), serviceDate);
        const morningFull = dayJobs.filter(j => j.serviceWindow === routingConfig.fridaySaturdayMorningWindow).length >= routingConfig.fridaySaturdayMorningMax;
        const afternoonFull = dayJobs.filter(j => j.serviceWindow === routingConfig.fridaySaturdayAfternoonWindow).length >= routingConfig.fridaySaturdayAfternoonMax;
        if (!morningFull) {
          results.push({ serviceDate, serviceDay: dayName, serviceCounty: matchedAllowed, serviceWindow: routingConfig.fridaySaturdayMorningWindow, readableDate: getReadableDate(serviceDate) });
        }
        if (!afternoonFull) {
          results.push({ serviceDate, serviceDay: dayName, serviceCounty: matchedAllowed, serviceWindow: routingConfig.fridaySaturdayAfternoonWindow, readableDate: getReadableDate(serviceDate) });
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
  <Gather input="dtmf" numDigits="5" action="${xmlEscape(zipUrl)}" method="POST" timeout="10">
    ${say("Please enter your five digit zip code.")}
  </Gather>
  ${say("We did not receive your zip code. Goodbye.")}
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
  const zip = (req.body.Digits || '').slice(0, 5);

  const slots = await findAvailableSlots(zip, 1, 7);

  res.type('text/xml');

  if (!slots.length) {
    res.send(`
<Response>
  ${say(`Sorry, ${digitsToWords(zip)} is not in our service area or there are no available appointments right now.`)}
  ${say("Please call again if you need anything else. Goodbye.")}
</Response>
`.trim());
    return;
  }

  const speech = buildAvailabilitySpeech(slots);
  const selectUrl = absoluteUrl(
    req,
    `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&startOffset=1`
  );

  res.send(`
<Response>
  ${say(`Thanks. ${digitsToWords(zip)} is in our service area.`)}
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
  const currentStartOffset = parseInt(req.query.startOffset || '1', 10);

  const speechText = req.body.SpeechResult || '';
  const futureOffset = detectFutureOffsetDays(speechText);

  res.type('text/xml');

  if (futureOffset !== null) {
    const futureSlots = await findAvailableSlots(zip, futureOffset, 3);

    if (!futureSlots.length) {
      const retryUrl = absoluteUrl(
        req,
        `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&startOffset=${encodeURIComponent(currentStartOffset)}`
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
      `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&startOffset=${encodeURIComponent(futureOffset)}`
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
      `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&startOffset=${encodeURIComponent(currentStartOffset)}`
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
      `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&startOffset=${encodeURIComponent(currentStartOffset)}`
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
    `/getNameForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(chosenSlot.serviceDate)}&serviceDay=${encodeURIComponent(chosenSlot.serviceDay)}&serviceCounty=${encodeURIComponent(chosenSlot.serviceCounty)}&serviceWindow=${encodeURIComponent(chosenSlot.serviceWindow)}`
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
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const name = normalizeNameText(req.body.SpeechResult);

  const phoneUrl = absoluteUrl(
    req,
    `/getPhoneForAppointment?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&serviceDate=${encodeURIComponent(serviceDate)}&serviceDay=${encodeURIComponent(serviceDay)}&serviceCounty=${encodeURIComponent(serviceCounty)}&serviceWindow=${encodeURIComponent(serviceWindow)}&name=${encodeURIComponent(name)}`
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
  const address = await normalizeAddressForKnownZip(rawAddress, zip);

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
  const address = await normalizeAddressForKnownZip(rawAddress, zip);

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

// ===== EMAIL CAPTURE FOR APPOINTMENTS (GPT-routed) =====
app.post('/getEmailForAppointment', wrapRoute(async (req, res) => {
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
  const rawSpeech = String(req.body.SpeechResult || '').trim();
  const email = await extractEmailViaGPT(rawSpeech, name);

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
app.get('/jobs', (req, res) => {
  const jobs = loadJobs();

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
    h1 {
      margin-bottom: 8px;
    }
    .refresh-note {
      color: #666666;
      font-size: 14px;
      margin-bottom: 16px;
    }
    .job {
      border: 1px solid #cccccc;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .job strong {
      font-size: 18px;
    }
    .line {
      margin-top: 4px;
    }
    a {
      color: #0b57d0;
    }
  </style>
</head>
<body>
  <h1>Jobs</h1>
  <div class="refresh-note">Auto-refreshing every 10 seconds</div>
`;

  if (jobs.length === 0) {
    html += '<p>No jobs yet</p>';
    html += '</body></html>';
    res.send(html);
    return;
  }

  jobs.forEach((job) => {
    html += `
  <div class="job">
    <strong>${job.time || ''}</strong>
    <div class="line">Type: ${job.requestType || ''}</div>
    <div class="line">Name: ${job.name || ''}</div>
    <div class="line">Machine: ${job.machine || ''}</div>
    <div class="line">Problem: ${job.problem || ''}</div>
    ${job.zip ? `<div class="line">ZIP: ${job.zip}</div>` : ''}
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

wss.on('connection', (ws, req) => {
  console.log('ConversationRelay connected');
  const callState = {
    machine: '', issue: '', zip: '', awaitingZipConfirmation: false,
    zipConfirmed: false, serviceable: false, askedForSchedule: false, inScheduling: false,
    offeredSlots: [], selectedSlot: null, selectedDay: null, dayConfirmed: false,
    timeWindow: '', serviceDate: '', callerName: '', phone: null,
    phoneConfirmed: false, address: null, addressConfirmed: false,
    email: null, emailConfirmed: false, booked: false,
    askedLastStarted: false, lastStartedAnswer: '', issueNeedsLastStarted: false,
    callEnded: false
  };

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

          // ===== EARLY ZIP QUESTION DETECTION =====
          // Only runs before ZIP is confirmed and before booking is in progress
          if (!callState.zipConfirmed && !callState.callerName && !callState.phone) {
            const possibleZip = normalizeSpokenDigits(text).slice(0, 5);
            const hasZip = possibleZip.length === 5;
            const isAreaQuestion =
              text.includes('service zip') ||
              text.includes('cover zip') ||
              text.includes('zip code') ||
              text.includes('what area') ||
              text.includes('service my area') ||
              text.includes('service that area');
            const hasMachineKeyword = config.machineTypes.some(m =>
              m.keywords.some(kw => text.includes(kw))
            );
            const isServiceQuestion =
              (text.includes('do you service') || text.includes('do you cover')) &&
              !hasMachineKeyword;

            if (hasZip || isAreaQuestion || (isServiceQuestion && !hasZip)) {
              if (hasZip) {
                callState.zip = possibleZip;
                const matchingCounties = getCountyForZip(callState.zip);
                const recognizedZip = matchingCounties.length > 0;
                if (recognizedZip) {
                  callState.zipConfirmed = true;
                  callState.serviceable = true;
                  callState.awaitingZipConfirmation = false;
                  if (callState.machine && callState.issue) {
                    ws.send(JSON.stringify({ type: 'text', token: 'Yeah, we do service that area. Do you want to get something scheduled?', last: true }));
                    callState.askedForSchedule = true;
                  } else if (callState.machine) {
                    ws.send(JSON.stringify({ type: 'text', token: `Yeah, we do service that area. What's going on with your ${callState.machine.toLowerCase()}?`, last: true }));
                  } else {
                    ws.send(JSON.stringify({ type: 'text', token: 'Yeah, we do service that area. What kind of equipment do you need help with?', last: true }));
                  }
                  break;
                }
                ws.send(JSON.stringify({ type: 'text', token: "Sorry, we don't service that ZIP code area. Goodbye.", last: true }));
                callState.callEnded = true;
                setTimeout(() => { try { ws.close(); } catch (e) {} }, 4000);
                break;
              }
              // Area question with no ZIP — ask for it
              ws.send(JSON.stringify({ type: 'text', token: 'What ZIP code are you in?', last: true }));
              break;
            }
          }

          // ===== EARLY EQUIPMENT QUESTION DETECTION =====
          // Only runs before machine is known and before booking is in progress
          if (!callState.machine && !callState.callerName && !callState.phone) {
            if (
              text.includes('do you work on') ||
              text.includes('do you fix') ||
              text.includes('do you repair') ||
              text.includes('do you service')
            ) {
              let detectedMachine = null;

              for (const m of config.machineTypes) {
                for (const keyword of m.keywords) {
                  if (text.includes(keyword)) {
                    detectedMachine = m.name;
                    break;
                  }
                }
                if (detectedMachine) break;
              }

              if (detectedMachine) {
                callState.machine = detectedMachine;
                ws.send(JSON.stringify({
                  type: 'text',
                  token: `Yeah, we do work on that. What's it doing or not doing?`,
                  last: true
                }));
                break;
              }

              ws.send(JSON.stringify({
                type: 'text',
                token: "Sorry, we don't work on that equipment.",
                last: true
              }));
              callState.callEnded = true;
              setTimeout(() => { try { ws.close(); } catch (e) {} }, 4000);
              break;
            }
          }

          console.log('Caller said:', userText);
          let reply = '';

          if (callState.callEnded) {
            break;
          }
          const isNoStartIssue =
            cleaned.includes('not starting') ||
            cleaned.includes('won t start') ||
            cleaned.includes('wont start') ||
            cleaned.includes('won t crank') ||
            cleaned.includes('wont crank') ||
            cleaned.includes('no start') ||
            cleaned.includes('doesn t start') ||
            cleaned.includes('doesnt start');

          // --- ZIP confirmation ---
          // Clear awaitingZipConfirmation if ZIP is already confirmed — prevents it from intercepting later turns
          if (callState.awaitingZipConfirmation && callState.zipConfirmed) {
            callState.awaitingZipConfirmation = false;
          }

          if (callState.awaitingZipConfirmation) {
            const dec = detectYesNoText(userText);
            if (dec === 'yes') {
              callState.awaitingZipConfirmation = false;
              callState.zipConfirmed = true;
              if (callState.serviceable) {
                // Already confirmed serviceable — skip re-check, go straight to slots
                const slots = await findAvailableSlots(callState.zip, 1, 7);
                callState.offeredSlots = slots;
                reply = slots.length
                  ? `Great. ${buildAvailabilitySpeech(slots)}`
                  : 'We service that area, but there are no available appointments right now. Please call back soon.';
              } else {
                const counties = getCountyForZip(callState.zip);
                if (!counties.length) {
                  reply = `Sorry, we do not service zip code ${callState.zip}. Please call back if you need anything else.`;
                } else {
                  callState.serviceable = true;
                  const slots = await findAvailableSlots(callState.zip, 1, 7);
                  callState.offeredSlots = slots;
                  reply = slots.length
                    ? `Great, we do service that area. ${buildAvailabilitySpeech(slots)}`
                    : 'We service that area, but there are no available appointments right now. Please call back soon.';
                }
              }
            } else if (dec === 'no') {
              callState.awaitingZipConfirmation = false;
              callState.zip = '';
              reply = 'Okay. What is your five digit zip code?';
            } else {
              reply = `I heard zip code ${callState.zip}. Is that correct?`;
            }
            ws.send(JSON.stringify({ type: 'text', token: reply, last: true }));
            break;
          }

          // --- Machine ---
          if (!callState.machine) {
            const m = detectMachine(userText);
            if (m) callState.machine = m;
          }
          if (!callState.machine) {
            ws.send(JSON.stringify({ type: 'text', token: 'What type of machine do you need help with?', last: true }));
            break;
          }

          // --- Issue ---
          if (!callState.issue) {
            const machineWords = config.machineOnlyWords;
            const isMachineOnly = machineWords.includes(cleaned) || cleaned === cleanText(callState.machine);
            const possibleZip = normalizeSpokenDigits(userText).slice(0, 5);

            if (!isMachineOnly && possibleZip.length !== 5) {

              const hasSymptom = config.symptomKeywords.some(kw => cleaned.includes(kw));

              const vaguePhrase =
                config.vagueIssuePhrases.some(vp => cleaned.includes(vp)) ||
                cleaned === 'not working' ||
                cleaned === 'needs fixed' ||
                cleaned === 'needs repair' ||
                cleaned === 'broken' ||
                cleaned.split(' ').length <= 3 && !hasSymptom;

              // Do not accept vague issues
              if (vaguePhrase) {
                ws.send(JSON.stringify({
                  type: 'text',
                  token: `Got it — what is it doing or not doing?`,
                  last: true
                }));
                break;
              }

              // Accept real issue
              if (hasSymptom) {
                callState.issue = userText.trim();

                if (isNoStartIssue) {
                  callState.issueNeedsLastStarted = true;
                }
              }
            }
          }

          if (!callState.issue) {
            ws.send(JSON.stringify({
              type: 'text',
              token: `What seems to be the issue with your ${callState.machine.toLowerCase()}?`,
              last: true
            }));
            break;
          }

          // --- No-start follow-up before scheduling / ZIP ---
          if (callState.issueNeedsLastStarted && !callState.askedLastStarted) {
            callState.askedLastStarted = true;
            ws.send(JSON.stringify({
              type: 'text',
              token: `Got it — ${callState.machine.toLowerCase()} not starting. When was the last time it started?`,
              last: true
            }));
            break;
          }

          if (callState.issueNeedsLastStarted && callState.askedLastStarted && !callState.lastStartedAnswer) {
            callState.lastStartedAnswer = userText.trim();
            callState.issue = `${callState.issue} | Last started: ${callState.lastStartedAnswer}`;
            ws.send(JSON.stringify({
              type: 'text',
              token: 'Would you like to schedule an appointment?',
              last: true
            }));
            callState.askedForSchedule = true;
            break;
          }

          // --- Ask to schedule before ZIP ---
          if (
            !callState.issueNeedsLastStarted &&
            !callState.askedForSchedule &&
            !callState.inScheduling &&
            !callState.selectedDay &&
            !callState.dayConfirmed &&
            !callState.booked
          ) {
            callState.askedForSchedule = true;
            ws.send(JSON.stringify({
              type: 'text',
              token: 'Do you want to get something scheduled?',
              last: true
            }));
            break;
          }

          if (callState.askedForSchedule) {
            const wants = cleaned.includes('yes') || cleaned.includes('schedule') || cleaned.includes('book') || cleaned.includes('appointment');
            if (wants) {
              callState.askedForSchedule = false;
              callState.inScheduling = true;
              if (callState.zipConfirmed && callState.zip) {
                const slots = await findAvailableSlots(callState.zip, 1, 7);
                callState.offeredSlots = slots;
                if (!slots.length) {
                  reply = 'Sorry, there are no available appointments right now. Please call back soon.';
                } else {
                  reply = buildAvailabilitySpeech(slots);
                }
                ws.send(JSON.stringify({ type: 'text', token: reply, last: true }));
                break;
              }
              ws.send(JSON.stringify({ type: 'text', token: "What's your ZIP code?", last: true }));
              break;
            }
            callState.askedForSchedule = false;
            reply = 'Alright, no problem.';
            ws.send(JSON.stringify({ type: 'text', token: reply, last: true }));
            break;
          }

          // --- ZIP capture ---
          if (callState.inScheduling && !callState.zipConfirmed) {
            const possibleZip = normalizeSpokenDigits(userText).slice(0,5);
            if (!callState.zip && possibleZip.length === 5) {
              callState.zip = possibleZip;
              callState.awaitingZipConfirmation = true;
              reply = `I heard zip code ${callState.zip}. Is that correct?`;
            } else if (!callState.zip) {
              reply = 'What is your five digit zip code?';
            } else {
              callState.awaitingZipConfirmation = true;
              reply = `I heard zip code ${callState.zip}. Is that correct?`;
            }
            ws.send(JSON.stringify({ type: 'text', token: reply, last: true }));
            break;
          }

          // --- Show availability after ZIP confirmed ---
          if (callState.zipConfirmed && callState.inScheduling && !callState.offeredSlots.length) {
            const slots = await findAvailableSlots(callState.zip, 1, 7);
            callState.offeredSlots = slots;
            if (!slots.length) {
              reply = 'Sorry, there are no available appointments right now. Please call back soon.';
            } else {
              reply = buildAvailabilitySpeech(slots);
            }
            ws.send(JSON.stringify({ type: 'text', token: reply, last: true }));
            break;
          }

          // --- Day/slot selection ---
          if (callState.inScheduling && !callState.dayConfirmed) {
            let matchedSlot = null;
            const speech = userText.toLowerCase();
            const isMorningSpeech = speech.includes('morning') || speech.includes('am') || speech.includes('a.m');
            const isAfternoonSpeech = speech.includes('afternoon') || speech.includes('pm') || speech.includes('p.m') || speech.includes('after');
            for (const slot of callState.offeredSlots) {
              const day = slot.serviceDay.toLowerCase();
              const slotDate = new Date(`${slot.serviceDate}T12:00:00`);
              const month = slotDate.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
              const dayNum = String(slotDate.getDate());
              const isMorning = slot.serviceWindow === '10:00 to 12:00';
              const isAfternoon = slot.serviceWindow === '1:00 to 4:00';
              if (speech.includes(day) && slot.serviceWindow === '10:00 to 10:30') { matchedSlot = slot; break; }
              if (speech.includes(day) && isMorning && isMorningSpeech) { matchedSlot = slot; break; }
              if (speech.includes(day) && isAfternoon && isAfternoonSpeech) { matchedSlot = slot; break; }
              if (speech.includes(month) && speech.includes(dayNum)) { matchedSlot = slot; break; }
            }
            // If caller said just "Friday" or "Saturday" with no morning/afternoon qualifier
            if (!matchedSlot && !isMorningSpeech && !isAfternoonSpeech) {
              const daySlots = callState.offeredSlots.filter(s => speech.includes(s.serviceDay.toLowerCase()));
              if (daySlots.length === 1) {
                matchedSlot = daySlots[0];
              } else if (daySlots.length > 1) {
                const dayName = daySlots[0].serviceDay;
                ws.send(JSON.stringify({ type: 'text', token: `Would you like ${dayName} morning or afternoon?`, last: true }));
                break;
              }
            }
            if (matchedSlot) {
              callState.selectedDay = matchedSlot.serviceDay;
              callState.serviceDate = matchedSlot.serviceDate;
              callState.timeWindow = matchedSlot.serviceWindow;
              callState.inScheduling = false;
              let win;
              if (matchedSlot.serviceWindow === '10:00 to 10:30') win = 'ten to ten thirty in the morning';
              else if (matchedSlot.serviceWindow === '10:00 to 12:00') win = 'morning between ten and noon';
              else if (matchedSlot.serviceWindow === '1:00 to 4:00') win = 'afternoon between one and four';
              else win = matchedSlot.serviceWindow;
              ws.send(JSON.stringify({ type: 'text', token: `Got it, ${matchedSlot.readableDate}, ${win}. Does that sound right?`, last: true }));
              break;
            }
            ws.send(JSON.stringify({ type: 'text', token: 'Please say the day, the date, or Friday or Saturday morning or afternoon.', last: true }));
            break;
          }

          // --- Confirm day yes/no ---
          if (callState.selectedDay && !callState.dayConfirmed) {
            if (text.includes('yes') || text.includes('correct') || text.includes('sounds right') || text.includes('that works')) {
              callState.dayConfirmed = true;
              ws.send(JSON.stringify({ type: 'text', token: 'Can I get your first and last name please?', last: true }));
            } else if (text.includes('no')) {
              callState.selectedDay = null;
              callState.serviceDate = '';
              callState.timeWindow = '';
              ws.send(JSON.stringify({ type: 'text', token: 'No problem. Which option would you like instead?', last: true }));
            } else {
              let win;
              if (callState.timeWindow === '10:00 to 10:30') win = 'ten to ten thirty in the morning';
              else if (callState.timeWindow === '10:00 to 12:00') win = 'morning between ten and noon';
              else if (callState.timeWindow === '1:00 to 4:00') win = 'afternoon between one and four';
              else win = callState.timeWindow;
              ws.send(JSON.stringify({ type: 'text', token: `Just to confirm, ${getReadableDate(callState.serviceDate)}, ${win}. Does that sound right?`, last: true }));
            }
            break;
          }

          // --- Name ---
          if (callState.dayConfirmed && !callState.callerName) {
            const rawName = normalizeNameText(userText);
            if (rawName && rawName.trim().length >= 2 && !/^\d+$/.test(rawName.trim())) {
              callState.callerName = rawName;
              ws.send(JSON.stringify({ type: 'text', token: `Got it, ${rawName}. What is the best phone number to reach you at?`, last: true }));
            } else {
              ws.send(JSON.stringify({ type: 'text', token: 'Can I get your first and last name please?', last: true }));
            }
            break;
          }

          // --- Phone ---
          if (callState.callerName && !callState.phone) {
            const digits = normalizeTenDigitPhone(normalizeSpokenDigits(userText));
            if (digits.length === 10) {
              callState.phone = digits;
              const spk = digits.slice(0,3).split('').join(' ') + ', ' + digits.slice(3,6).split('').join(' ') + ', ' + digits.slice(6).split('').join(' ');
              ws.send(JSON.stringify({ type: 'text', token: `I have ${spk}. Is that correct?`, last: true }));
            } else {
              ws.send(JSON.stringify({ type: 'text', token: 'What is the best phone number to reach you at?', last: true }));
            }
            break;
          }

          // --- Confirm phone ---
          if (callState.phone && !callState.phoneConfirmed) {
            if (text.includes('yes') || text.includes('correct')) {
              callState.phoneConfirmed = true;
              ws.send(JSON.stringify({ type: 'text', token: 'What is the service address?', last: true }));
            } else {
              callState.phone = null;
              ws.send(JSON.stringify({ type: 'text', token: 'Okay. What is the correct phone number?', last: true }));
            }
            break;
          }

          // --- Address ---
          if (callState.phoneConfirmed && !callState.address) {
            const raw = String(userText || '').trim();
            if (raw.length >= 5) {
              callState.address = normalizeAddressText(applyLocalCorrections(rejoinSpacedDigits(raw)));
              const addrSpeak = formatStreetNumberForSpeech(callState.address);
              ws.send(JSON.stringify({ type: 'text', token: `I have ${addrSpeak}. Is that correct?`, last: true }));
            } else {
              ws.send(JSON.stringify({ type: 'text', token: 'What is the service address?', last: true }));
            }
            break;
          }

          // --- Confirm address ---
          if (callState.address && !callState.addressConfirmed) {
            if (text.includes('yes') || text.includes('correct')) {
              callState.addressConfirmed = true;
              ws.send(JSON.stringify({ type: 'text', token: 'What email address should we send the confirmation to?', last: true }));
            } else {
              callState.address = null;
              ws.send(JSON.stringify({ type: 'text', token: 'What is the correct service address?', last: true }));
            }
            break;
          }

          // --- Email (GPT-routed) ---
          if (callState.addressConfirmed && !callState.email) {
            const rawEmail = await extractEmailViaGPT(userText, callState.callerName);
            if (rawEmail && rawEmail.includes('@')) {
              callState.email = rawEmail;
              ws.send(JSON.stringify({ type: 'text', token: `I have ${formatEmailForSpeech(rawEmail)}. Is that correct?`, last: true }));
            } else {
              ws.send(JSON.stringify({ type: 'text', token: 'What email address should we send the confirmation to?', last: true }));
            }
            break;
          }

          // --- Confirm email + book ---
          if (callState.email && !callState.emailConfirmed) {
            if (text.includes('yes') || text.includes('correct')) {
              callState.emailConfirmed = true;
              const job = {
                id: generateJobId(),
                requestType: 'Appointment Request',
                name: callState.callerName || 'Phone Caller',
                machine: callState.machine || 'Unknown',
                problem: callState.issue || 'Unknown',
                zip: callState.zip || '',
                phone: callState.phone || '',
                address: callState.address || '',
                email: callState.email || '',
                serviceDate: callState.serviceDate || '',
                serviceDay: callState.selectedDay || '',
                serviceWindow: callState.timeWindow || '',
                time: getEasternTimestamp()
              };
              saveJob(job);
              try {
                await sendAppointmentConfirmationEmail({
                  to: callState.email,
                  name: callState.callerName || 'Customer',
                  machine: callState.machine,
                  issue: callState.issue,
                  serviceDate: callState.serviceDate || callState.selectedDay || '',
                  serviceWindow: callState.timeWindow || '',
                  address: callState.address
                });
              } catch (err) { console.error('Email failed:', err); }
              const readableAppt = callState.serviceDate ? getReadableDate(callState.serviceDate) : callState.selectedDay;
              ws.send(JSON.stringify({ type: 'text', token: `You are all set, ${callState.callerName}. Your appointment is confirmed for ${readableAppt} between ${callState.timeWindow}. A confirmation is on its way to ${formatEmailForSpeech(callState.email)}. Thank you, goodbye.`, last: true }));
              callState.booked = true;
              callState.callEnded = true;
              setTimeout(() => { try { ws.close(); } catch (e) {} }, 15000);
            } else {
              callState.email = null;
              ws.send(JSON.stringify({ type: 'text', token: 'What is the correct email address?', last: true }));
            }
            break;
          }

          if (callState.booked) {
            ws.send(JSON.stringify({ type: 'text', token: 'Your appointment is already confirmed. Have a great day.', last: true }));
            break;
          }

          // Fallback to AI
          const aiReply = await getAIResponse(userText);
          ws.send(JSON.stringify({ type: 'text', token: aiReply, last: true }));
          break;
        }
        case 'interrupt':
          console.log('Caller interrupted');
          break;
        default:
          console.log('Unhandled event:', data.type);
          break;
      }
    } catch (err) {
      console.error('WebSocket error:', err);
    }
  });
  ws.on('close', () => console.log('ConversationRelay disconnected'));
});
