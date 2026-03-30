const express = require('express');
const fs = require('fs');
const nodemailer = require('nodemailer');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const JOBS_FILE = 'jobs.json';

// ===== HOME / ROUTING SETTINGS =====
const routingConfig = {
  homeZip: '20724',

  mondayThroughThursdayPlan: {
    Monday: "Prince George's",
    Tuesday: "Howard",
    Wednesday: "Anne Arundel",
    Thursday: "Baltimore County"
  },

  fridayAllowedCounties: ['Anne Arundel', 'Howard'],
  saturdayAllowedCounties: ['Howard', "Prince George's"],

  mondayThursdayWindow: '10:00 to 10:30',
  fridaySaturdayMorningWindow: '10:00 to 12:00',
  fridaySaturdayAfternoonWindow: '1:00 to 4:00',

  mondayThursdayMax: 1,
  fridaySaturdayMorningMax: 2,
  fridaySaturdayAfternoonMax: 3
};

// ===== EMAIL SETTINGS =====
function getEmailRuntimeConfig() {
  const rawFrom = process.env.EMAIL_FROM || 'christopher@rlsmallengines.com';
  const rawHost = process.env.EMAIL_HOST || 'smtp.hostinger.com';
  const rawPort = process.env.EMAIL_PORT || '465';
  const rawSecure = process.env.EMAIL_SECURE || 'true';
  const rawUser = process.env.EMAIL_USER || 'christopher@rlsmallengines.com';
  const rawPass = process.env.EMAIL_PASS || 'Kyala2599!';

  const parsedPort = parseInt(rawPort, 10);

  return {
    from: rawFrom,
    host: rawHost,
    port: parsedPort,
    secure: String(rawSecure).toLowerCase() === 'true',
    user: rawUser,
    pass: rawPass,
    rawPort,
    rawSecure
  };
}

function canSendEmail() {
  const cfg = getEmailRuntimeConfig();

  return Boolean(
    cfg.from &&
    cfg.host &&
    cfg.port &&
    !Number.isNaN(cfg.port) &&
    cfg.user &&
    cfg.pass
  );
}

let mailTransporter = null;
let lastTransporterKey = '';

function getMailTransporter() {
  const cfg = getEmailRuntimeConfig();

  if (!canSendEmail()) {
    return null;
  }

  const transporterKey = JSON.stringify({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    from: cfg.from
  });

  if (!mailTransporter || lastTransporterKey !== transporterKey) {
    mailTransporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: {
        user: cfg.user,
        pass: cfg.pass
      }
    });

    lastTransporterKey = transporterKey;
  }

  return mailTransporter;
}

async function sendAppointmentConfirmationEmail({
  to,
  name,
  machine,
  issue,
  serviceDate,
  serviceWindow,
  address
}) {
  const cfg = getEmailRuntimeConfig();
  const transporter = getMailTransporter();

  if (!transporter) {
    console.log('Email not sent: transporter not configured');
    return { sent: false, reason: 'not_configured' };
  }

  const readableDate = getReadableDate(serviceDate);

  const subject = `RL Small Engines Appointment Confirmation - ${readableDate}`;
  const textBody = [
    `Hello ${name || 'Customer'},`,
    '',
    'Your appointment with RL Small Engines has been confirmed.',
    '',
    `Service: ${machine || 'Unknown'}`,
    `Issue: ${issue || 'Unknown'}`,
    `Date: ${readableDate || ''}`,
    `Time Window: ${serviceWindow || ''}`,
    `Address: ${address || ''}`,
    '',
    'Thank you,',
    'RL Small Engines'
  ].join('\n');

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; color: #111111; line-height: 1.5;">
      <p>Hello ${xmlEscape(name || 'Customer')},</p>
      <p>Your appointment with <strong>RL Small Engines</strong> has been confirmed.</p>
      <p>
        <strong>Service:</strong> ${xmlEscape(machine || 'Unknown')}<br/>
        <strong>Issue:</strong> ${xmlEscape(issue || 'Unknown')}<br/>
        <strong>Date:</strong> ${xmlEscape(readableDate || '')}<br/>
        <strong>Time Window:</strong> ${xmlEscape(serviceWindow || '')}<br/>
        <strong>Address:</strong> ${xmlEscape(address || '')}
      </p>
      <p>Thank you,<br/>RL Small Engines</p>
    </div>
  `;

  console.log('Attempting appointment confirmation email to:', to);

  await transporter.sendMail({
    from: cfg.from,
    to,
    subject,
    text: textBody,
    html: htmlBody
  });

  console.log('Appointment confirmation email sent successfully to:', to);

  return { sent: true };
}

// ===== COUNTY ZIP MAPS =====
const countyZips = {
  "Prince George's": [
    '20707', '20705', '20708', '20783', '20742', '20771', '20769', '20706',
    '20737', '20782', '20781', '20784', '20720', '20715', '20721', '20716',
    '20785', '20743', '20747', '20746', '20774', '20748', '20745', '20735',
    '20772', '20623', '20744', '20607', '20613'
  ],
  "Howard": [
    '20701', '21029', '21044', '21045', '21046', '21075', '20759',
    '21076', '20777', '20794', '20723', '21042', '21043'
  ],
  "Anne Arundel": [
    '21401', '21402', '21403', '21012', '21114', '21032', '21035',
    '21037', '21054', '21060', '21061', '21076', '21077', '20776',
    '20794', '20724', '21090', '21108', '21113', '21122', '21140',
    '21144', '21146'
  ],
  "Baltimore County": [
    '21228', '21043', '21227', '21208', '21133', '21136', '21244', '21163'
  ]
};

// ===== LOCAL CORRECTION LAYER =====
const exactPhraseCorrections = [
  ['bevern', 'severn'],
  ['seven maryland', 'severn maryland'],
  ['7 maryland', 'severn maryland'],
  ['severn marylin', 'severn maryland'],
  ['stubborn maryland', 'severn maryland'],
  ['stubbern maryland', 'severn maryland'],
  ['odenton marylin', 'odenton maryland'],
  ['glen bernie', 'glen burnie'],
  ['glen berny', 'glen burnie'],
  ['glenn burnie', 'glen burnie'],
  ['bowy', 'bowie'],
  ['booie', 'bowie'],
  ['bui', 'bowie'],
  ['lanhamm', 'lanham'],
  ['lanem', 'lanham'],
  ['croftonn', 'crofton'],
  ['millersvile', 'millersville'],
  ['pasadenaa', 'pasadena'],
  ['gambrillss', 'gambrills'],
  ['laurel marylin', 'laurel maryland'],
  ['bel air road', 'belair road'],
  ['belair rd', 'belair road'],
  ['ain arundel', 'anne arundel'],
  ['anne arundele', 'anne arundel'],
  ['lawn tractor', 'riding mower'],
  ['ride on mower', 'riding mower'],
  ['rider mower', 'riding mower'],
  ['push mower', 'lawnmower'],
  ['pressure washing machine', 'pressure washer'],
  ['snow blower', 'snowblower']
];

const wordCorrections = {
  bevern: 'severn',
  sevenn: 'severn',
  severnn: 'severn',
  stubborn: 'severn',
  stubbern: 'severn',
  glenn: 'glen',
  bernie: 'burnie',
  berny: 'burnie',
  bowy: 'bowie',
  booie: 'bowie',
  lanem: 'lanham',
  lanhamm: 'lanham',
  croftonn: 'crofton',
  millersvile: 'millersville',
  pasadenaa: 'pasadena',
  gambrillss: 'gambrills',
  arundele: 'arundel',
  marylin: 'maryland'
};

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
    .replace(/[?!"“”]/g, ' ')
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
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
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

function formatEmailForSpeech(email) {
  return String(email || '')
    .replace(/[._+\-]+$/, '')
    .replace(/@/g, ' at ')
    .replace(/\./g, ' dot ')
    .replace(/_/g, ' underscore ')
    .replace(/-/g, ' dash ')
    .replace(/\+/g, ' plus ')
    .replace(/\s+/g, ' ')
    .trim();
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

function buildOptionSpeech(slots) {
  let speech = 'Here are the next available appointments. ';
  slots.forEach((slot, index) => {
    speech += `Option ${index + 1}, ${slot.readableDate}, between ${slot.serviceWindow}. `;
  });
  return speech;
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

  if (
    cleaned.includes('riding') ||
    cleaned.includes('tractor') ||
    cleaned.includes('riding mower') ||
    cleaned.includes('lawn tractor') ||
    cleaned.includes('ride mower') ||
    cleaned.includes('rider')
  ) {
    return 'Riding mower';
  }

  if (
    cleaned.includes('lawn mower') ||
    cleaned === 'mower' ||
    cleaned.includes('push mower') ||
    cleaned.includes('lawnmower')
  ) {
    return 'Lawnmower';
  }

  if (cleaned.includes('generator') || cleaned === 'gen') {
    return 'Generator';
  }

  if (
    cleaned.includes('pressure washer') ||
    cleaned.includes('power washer')
  ) {
    return 'Pressure washer';
  }

  if (
    cleaned.includes('snow blower') ||
    cleaned.includes('snowblower') ||
    cleaned.includes('snow thrower')
  ) {
    return 'Snowblower';
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
    const targetCounty = routingConfig.mondayThroughThursdayPlan[dayName];
    if (!matchingCounties.includes(targetCounty)) {
      return null;
    }

    if (dayJobs.length < routingConfig.mondayThursdayMax) {
      return {
        serviceDate,
        serviceDay: dayName,
        serviceCounty: targetCounty,
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

    const slot = await getSlotForDate(zip, serviceDate, dayName);

    if (slot) {
      results.push({
        ...slot,
        readableDate: getReadableDate(slot.serviceDate)
      });
    }
  }

  return results;
}

// ===== CALL FLOW START =====
function buildVoiceTwiml(req) {
  const helpUrl = absoluteUrl(req, '/getHelpRequest');

  return `
<Response>
  <Gather input="speech" action="${xmlEscape(helpUrl)}" method="POST" speechTimeout="auto" timeout="6">
    ${say("Hello, you have reached R L Small Engines. My name is Emma. How can I help you today?")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim();
}

app.get('/', (req, res) => {
  res.send('RL AI Receptionist is running');
});

// ===== TEST EMAIL ROUTE =====
app.get('/test-email', wrapRoute(async (req, res) => {
  const cfg = getEmailRuntimeConfig();
  const to = req.query.to || cfg.user || cfg.from;

  const debug = {
    hasFrom: Boolean(cfg.from),
    hasHost: Boolean(cfg.host),
    hasUser: Boolean(cfg.user),
    hasPass: Boolean(cfg.pass),
    hasRawPort: Boolean(cfg.rawPort),
    parsedPort: cfg.port,
    portIsValid: !Number.isNaN(cfg.port) && Boolean(cfg.port),
    rawSecure: cfg.rawSecure,
    parsedSecure: cfg.secure,
    canSendEmail: canSendEmail(),
    chosenRecipient: to || ''
  };

  if (!to) {
    res.status(200).type('text/plain').send(`TEST EMAIL FAILED: no recipient available\n${JSON.stringify(debug, null, 2)}`);
    return;
  }

  if (!canSendEmail()) {
    res.status(200).type('text/plain').send(`TEST EMAIL FAILED: {"sent":false,"reason":"not_configured"}\n${JSON.stringify(debug, null, 2)}`);
    return;
  }

  try {
    const result = await sendAppointmentConfirmationEmail({
      to,
      name: 'Test Customer',
      machine: 'Snowblower',
      issue: 'Test email check',
      serviceDate: formatEasternDateKey(getEasternNow()),
      serviceWindow: '10:00 to 12:00',
      address: '1748 Old Georgetown Court Severn Maryland 21144'
    });

    if (result && result.sent) {
      res.status(200).type('text/plain').send(`EMAIL SENT TO: ${to}\n${JSON.stringify(debug, null, 2)}`);
      return;
    }

    res.status(200).type('text/plain').send(`TEST EMAIL FAILED: ${JSON.stringify(result)}\n${JSON.stringify(debug, null, 2)}`);
  } catch (error) {
    res.status(200).type('text/plain').send(
      `TEST EMAIL FAILED WITH ERROR:\n${error && error.message ? error.message : String(error)}\n${JSON.stringify(debug, null, 2)}`
    );
  }
}));

app.get('/debug-env', (req, res) => {
  res.type('text/plain').send([
    'EMAIL_FROM: ' + (process.env.EMAIL_FROM || '(empty)'),
    'EMAIL_HOST: ' + (process.env.EMAIL_HOST || '(empty)'),
    'EMAIL_PORT: ' + (process.env.EMAIL_PORT || '(empty)'),
    'EMAIL_SECURE: ' + (process.env.EMAIL_SECURE || '(empty)'),
    'EMAIL_USER: ' + (process.env.EMAIL_USER || '(empty)'),
    'EMAIL_PASS: ' + (process.env.EMAIL_PASS ? '(set)' : '(empty)'),
  ].join('\n'));
});

app.get('/voice', wrapRoute((req, res) => {
  res.type('text/xml');
  res.send(buildVoiceTwiml(req));
}));

app.post('/voice', wrapRoute((req, res) => {
  res.type('text/xml');
  res.send(buildVoiceTwiml(req));
}));

// ===== STEP 1: HELP REQUEST / EXTRACT MACHINE =====
app.post('/getHelpRequest', wrapRoute((req, res) => {
  const helpRequest = req.body.SpeechResult || '';
  const detectedMachine = detectMachine(helpRequest);

  const retryUrl = absoluteUrl(req, '/getHelpRequest');
  const issueUrl = absoluteUrl(
    req,
    `/getIssue?machine=${encodeURIComponent(detectedMachine || '')}`
  );

  res.type('text/xml');

  if (!detectedMachine) {
    res.send(`
<Response>
  ${say("Sorry, I could not tell what machine you need help with.")}
  <Gather input="speech" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="6">
    ${say("Please tell me what machine you need help with, like a lawnmower, riding mower, generator, pressure washer, or snowblower.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  ${say("Got it. I can help you with that.")}
  <Gather input="speech" action="${xmlEscape(issueUrl)}" method="POST" speechTimeout="auto" timeout="6">
    ${say(`Please briefly describe the problem with your ${detectedMachine}.`)}
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

  const slots = await findAvailableSlots(zip, 1, 3);

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

  const optionsSpeech = buildOptionSpeech(slots);
  const selectUrl = absoluteUrl(
    req,
    `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&startOffset=1`
  );

  res.send(`
<Response>
  ${say(`Thanks. ${digitsToWords(zip)} is in our service area.`)}
  ${pause(1)}
  ${say(optionsSpeech)}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(selectUrl)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("Press or say option 1, 2, or 3. You can also say next week or two weeks out.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
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
  const selectedOption = detectOptionSelection(req);

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

  if (!selectedOption) {
    const currentSlots = await findAvailableSlots(zip, currentStartOffset, 3);
    const currentSpeech = currentSlots.length ? buildOptionSpeech(currentSlots) : '';
    const retryUrl = absoluteUrl(
      req,
      `/selectAppointmentOption?machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}&zip=${encodeURIComponent(zip)}&startOffset=${encodeURIComponent(currentStartOffset)}`
    );

    res.send(`
<Response>
  ${currentSpeech ? say(currentSpeech) : ''}
  <Gather input="speech dtmf" numDigits="1" action="${xmlEscape(retryUrl)}" method="POST" speechTimeout="auto" timeout="8">
    ${say("I did not understand. Please say or press option 1, 2, or 3.")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
    return;
  }

  const currentSlots = await findAvailableSlots(zip, currentStartOffset, 3);
  const chosenSlot = currentSlots[selectedOption - 1];

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
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
