const express = require('express');
const fs = require('fs');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const JOBS_FILE = 'jobs.json';

// ===== HOME / ROUTING SETTINGS =====
const routingConfig = {
  homeZip: '20724',

  // Update these on Sunday whenever needed
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

// ===== HELPERS =====
function cleanText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s@.\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return 'Unknown';
  return cleaned
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatDigitsForSpeech(digits) {
  return (digits || '').split('').join(' ');
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

// ===== ZIP COORDINATES + DISTANCE =====
const zipCoordCache = {};

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
  } catch {
    return null;
  }
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
  const cleaned = cleanText(input);

  if (
    cleaned.includes('riding') ||
    cleaned.includes('tractor') ||
    cleaned.includes('lawn tractor') ||
    cleaned.includes('ride mower') ||
    cleaned.includes('rider')
  ) {
    return 'Riding mower';
  }

  if (
    cleaned.includes('lawn mower') ||
    cleaned === 'mower' ||
    cleaned.includes('push mower')
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

function extractPhoneFromRequest(req) {
  const dtmf = String(req.body.Digits || '').replace(/\D/g, '');
  if (dtmf.length >= 10) {
    return dtmf.slice(0, 10);
  }

  const speech = req.body.SpeechResult || '';
  const speechDigits = normalizeSpokenDigits(speech);
  if (speechDigits.length >= 10) {
    return speechDigits.slice(0, 10);
  }

  return '';
}

// ===== ADDRESS PARSING =====
function extractAddressFromSpeech(req) {
  const raw = String(req.body.SpeechResult || '').trim();
  if (!raw) return '';

  return raw
    .replace(/\s+/g, ' ')
    .trim();
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

async function findNextAvailableSlot(zip) {
  const matchingCounties = getCountyForZip(zip);
  if (matchingCounties.length === 0) return null;

  const existingJobs = loadJobs();
  const now = getEasternNow();

  for (let offset = 1; offset <= 30; offset += 1) {
    const future = new Date(now);
    future.setDate(now.getDate() + offset);

    const serviceDate = formatEasternDateKey(future);
    const dayName = getDayNameInEastern(future);

    if (dayName === 'Sunday') continue;

    const dayJobs = getAppointmentJobsForDate(existingJobs, serviceDate);

    if (
      dayName === 'Monday' ||
      dayName === 'Tuesday' ||
      dayName === 'Wednesday' ||
      dayName === 'Thursday'
    ) {
      const targetCounty = routingConfig.mondayThroughThursdayPlan[dayName];
      if (!matchingCounties.includes(targetCounty)) continue;

      if (dayJobs.length < routingConfig.mondayThursdayMax) {
        return {
          serviceDate,
          serviceDay: dayName,
          serviceCounty: targetCounty,
          serviceWindow: routingConfig.mondayThursdayWindow
        };
      }

      continue;
    }

    if (dayName === 'Friday' || dayName === 'Saturday') {
      const allowed =
        dayName === 'Friday'
          ? routingConfig.fridayAllowedCounties
          : routingConfig.saturdayAllowedCounties;

      const matchedAllowed = matchingCounties.find((county) =>
        allowed.includes(county)
      );

      if (!matchedAllowed) continue;

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
    }
  }

  return {
    serviceDate: '',
    serviceDay: '',
    serviceCounty: matchingCounties[0] || 'Unknown',
    serviceWindow: 'We will contact you to schedule your service window.'
  };
}

// ===== CALL FLOW START =====
function buildVoiceTwiml() {
  return `
<Response>
  <Gather input="speech" action="/getHelpRequest" method="POST" speechTimeout="auto" timeout="6">
    ${say("Hello, you have reached R L Small Engines. My name is Emma. How can I help you today?")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim();
}

app.get('/', (req, res) => {
  res.send('RL AI Receptionist is running');
});

app.get('/voice', (req, res) => {
  res.type('text/xml');
  res.send(buildVoiceTwiml());
});

app.post('/voice', (req, res) => {
  res.type('text/xml');
  res.send(buildVoiceTwiml());
});

// ===== STEP 1: HELP REQUEST / EXTRACT MACHINE =====
app.post('/getHelpRequest', (req, res) => {
  const helpRequest = req.body.SpeechResult || '';
  const detectedMachine = detectMachine(helpRequest);

  res.type('text/xml');

  if (!detectedMachine) {
    res.send(`
<Response>
  ${say("Sorry, I could not tell what machine you need help with.")}
  <Gather input="speech" action="/getHelpRequest" method="POST" speechTimeout="auto" timeout="6">
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
  <Gather input="speech" action="/getIssue?machine=${encodeURIComponent(detectedMachine)}" method="POST" speechTimeout="auto" timeout="6">
    ${say(`Please briefly describe the problem with your ${detectedMachine}.`)}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
});

// ===== STEP 2: ISSUE =====
app.post('/getIssue', (req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = titleCase(req.body.SpeechResult);

  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="speech" action="/scheduleDecision?machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}" method="POST" speechTimeout="auto" timeout="5">
    ${say("Would you like to schedule an appointment?")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
});

// ===== STEP 3: SCHEDULE DECISION =====
app.post('/scheduleDecision', (req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const decision = cleanText(req.body.SpeechResult || '');

  const wantsAppointment =
    decision.includes('yes') ||
    decision.includes('schedule') ||
    decision.includes('book') ||
    decision.includes('appointment');

  res.type('text/xml');

  if (wantsAppointment) {
    res.send(`
<Response>
  <Gather input="dtmf" numDigits="5" action="/getZipForAppointment?machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}" method="POST" timeout="10">
    ${say("Please enter your five digit zip code.")}
  </Gather>
  ${say("We did not receive your zip code. Goodbye.")}
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  <Gather input="speech" action="/getNameForMessage?machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}" method="POST" speechTimeout="auto" timeout="6">
    ${say("No problem. Can I get your first and last name, please?")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
});

// ===== STEP 4A: APPOINTMENT ZIP / CHECK AVAILABILITY =====
app.post('/getZipForAppointment', async (req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = (req.body.Digits || '').slice(0, 5);

  const slot = await findNextAvailableSlot(zip);

  res.type('text/xml');

  if (!slot) {
    const spokenZip = formatDigitsForSpeech(zip);
    res.send(`
<Response>
  ${say(`Sorry, ${spokenZip} is not in our service area.`)}
  ${say("Please call again if you need anything else. Goodbye.")}
</Response>
`.trim());
    return;
  }

  if (!slot.serviceDay || !slot.serviceWindow) {
    res.send(`
<Response>
  ${say("We could not find an available service window right now.")}
  ${say("We will contact you for the next available opening. Goodbye.")}
</Response>
`.trim());
    return;
  }

  const readableDate = getReadableDate(slot.serviceDate);

  res.send(`
<Response>
  ${say(`Thanks. ${formatDigitsForSpeech(zip)} is in our service area.`)}
  ${pause(1)}
  ${say(`The next available service window is ${readableDate}, between ${slot.serviceWindow}.`)}
  <Gather input="speech" action="/confirmAppointmentSlot?machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}&amp;serviceDate=${encodeURIComponent(slot.serviceDate)}&amp;serviceDay=${encodeURIComponent(slot.serviceDay)}&amp;serviceCounty=${encodeURIComponent(slot.serviceCounty)}&amp;serviceWindow=${encodeURIComponent(slot.serviceWindow)}" method="POST" speechTimeout="auto" timeout="5">
    ${say("Would you like that appointment?")}
  </Gather>
  ${say("I did not hear anything. Goodbye.")}
</Response>
`.trim());
});

// ===== STEP 4B: APPOINTMENT SLOT DECISION =====
app.post('/confirmAppointmentSlot', (req, res) => {
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const serviceDate = req.query.serviceDate || '';
  const serviceDay = req.query.serviceDay || '';
  const serviceCounty = req.query.serviceCounty || '';
  const serviceWindow = req.query.serviceWindow || '';
  const decision = cleanText(req.body.SpeechResult || '');

  const accepted =
    decision.includes('yes') ||
    decision.includes('that works') ||
    decision.includes('works') ||
    decision.includes('okay') ||
    decision.includes('ok
