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

// ===== MACHINE DETECTION =====
function cleanText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
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

function detectMachine(input) {
  const cleaned = cleanText(input);

  // Riding mower first
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

// ===== GENERAL HELPERS =====
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

function loadJobs() {
  if (!fs.existsSync(JOBS_FILE)) {
    return [];
  }

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

function generateJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ===== ZIP COORDINATES + DISTANCE =====
const zipCoordCache = {};

async function getZipCoordinates(zip) {
  if (!zip) return null;
  if (zipCoordCache[zip]) return zipCoordCache[zip];

  try {
    const response = await fetch(`https://api.zippopotam.us/us/${zip}`);
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const place = data?.places?.[0];

    if (!place) return null;

    const coords = {
      lat: parseFloat(place.latitude),
      lon: parseFloat(place.longitude)
    };

    if (Number.isNaN(coords.lat) || Number.isNaN(coords.lon)) {
      return null;
    }

    zipCoordCache[zip] = coords;
    return coords;
  } catch {
    return null;
  }
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 3958.8;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getDistanceFromHomeMiles(zip) {
  const homeCoords = await getZipCoordinates(routingConfig.homeZip);
  const jobCoords = await getZipCoordinates(zip);

  if (!homeCoords || !jobCoords) {
    return 999999;
  }

  return haversineMiles(homeCoords.lat, homeCoords.lon, jobCoords.lat, jobCoords.lon);
}

// ===== ROUTING + LIMITS =====
function getAppointmentJobsForDate(jobs, serviceDate) {
  return jobs.filter(
    (job) =>
      job.requestType === 'Appointment Request' &&
      job.serviceDate === serviceDate
  );
}

async function rebalanceFridaySaturdayJobs(serviceDate) {
  const jobs = loadJobs();
  const dayJobs = jobs.filter(
    (job) =>
      job.requestType === 'Appointment Request' &&
      job.serviceDate === serviceDate
  );

  if (dayJobs.length === 0) {
    return;
  }

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

  if (matchingCounties.length === 0) {
    return null;
  }

  const existingJobs = loadJobs();
  const now = getEasternNow();

  for (let offset = 1; offset <= 30; offset += 1) {
    const future = new Date(now);
    future.setDate(now.getDate() + offset);

    const serviceDate = formatEasternDateKey(future);
    const dayName = getDayNameInEastern(future);

    if (dayName === 'Sunday') {
      continue;
    }

    const dayJobs = getAppointmentJobsForDate(existingJobs, serviceDate);

    if (
      dayName === 'Monday' ||
      dayName === 'Tuesday' ||
      dayName === 'Wednesday' ||
      dayName === 'Thursday'
    ) {
      const targetCounty = routingConfig.mondayThroughThursdayPlan[dayName];
      if (!matchingCounties.includes(targetCounty)) {
        continue;
      }

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

    if (dayName === 'Friday') {
      const allowed = routingConfig.fridayAllowedCounties;
      const matchedAllowed = matchingCounties.find((county) =>
        allowed.includes(county)
      );

      if (!matchedAllowed) {
        continue;
      }

      if (
        dayJobs.length <
        routingConfig.fridaySaturdayMorningMax +
          routingConfig.fridaySaturdayAfternoonMax
      ) {
        const tempCandidate = {
          id: '__temp__',
          zip
        };

        const compareList = [];

        for (const job of dayJobs) {
          compareList.push({
            id: job.id,
            zip: job.zip
          });
        }

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

      continue;
    }

    if (dayName === 'Saturday') {
      const allowed = routingConfig.saturdayAllowedCounties;
      const matchedAllowed = matchingCounties.find((county) =>
        allowed.includes(county)
      );

      if (!matchedAllowed) {
        continue;
      }

      if (
        dayJobs.length <
        routingConfig.fridaySaturdayMorningMax +
          routingConfig.fridaySaturdayAfternoonMax
      ) {
        const tempCandidate = {
          id: '__temp__',
          zip
        };

        const compareList = [];

        for (const job of dayJobs) {
          compareList.push({
            id: job.id,
            zip: job.zip
          });
        }

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

// ===== TWIML START =====
function buildVoiceTwiml() {
  return `
<Response>
  <Gather input="speech" action="/getName" method="POST" speechTimeout="auto" timeout="5">
    <Say>Hello, this is R L Small Engines. Please say your name.</Say>
  </Gather>
  <Say>I did not hear anything. Goodbye.</Say>
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

// ===== NAME =====
app.post('/getName', (req, res) => {
  const name = titleCase(req.body.SpeechResult);

  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="dtmf" numDigits="1" timeout="10" action="/checkName?name=${encodeURIComponent(name)}" method="POST">
    <Say>I heard ${xmlEscape(name)}. If this is correct, press 1. To say your name again, press 2.</Say>
  </Gather>
  <Say>We did not receive a response. Goodbye.</Say>
</Response>
`.trim());
});

app.post('/checkName', (req, res) => {
  const name = req.query.name || 'Unknown';
  const choice = req.body.Digits || '';

  res.type('text/xml');

  if (choice === '2') {
    res.send(`
<Response>
  <Gather input="speech" action="/getName" method="POST" speechTimeout="auto" timeout="5">
    <Say>Please say your name again.</Say>
  </Gather>
  <Say>I did not hear anything. Goodbye.</Say>
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  <Gather input="speech" action="/getMachine?name=${encodeURIComponent(name)}" method="POST" speechTimeout="auto" timeout="5">
    <Say>Thank you ${xmlEscape(name)}. What machine are you calling about? For example, lawnmower, riding mower, generator, pressure washer, or snowblower.</Say>
  </Gather>
  <Say>I did not hear anything. Goodbye.</Say>
</Response>
`.trim());
});

// ===== MACHINE =====
app.post('/getMachine', (req, res) => {
  const name = req.query.name || 'Unknown';
  const rawMachine = req.body.SpeechResult || '';
  const spokenMachine = titleCase(rawMachine);
  const detectedMachine = detectMachine(rawMachine);

  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="dtmf" numDigits="1" timeout="10" action="/checkMachine?name=${encodeURIComponent(name)}&amp;spoken=${encodeURIComponent(spokenMachine)}&amp;detected=${encodeURIComponent(detectedMachine || '')}" method="POST">
    <Say>I heard ${xmlEscape(spokenMachine)}. If this is correct, press 1. To say the machine again, press 2.</Say>
  </Gather>
  <Say>We did not receive a response. Goodbye.</Say>
</Response>
`.trim());
});

app.post('/checkMachine', (req, res) => {
  const name = req.query.name || 'Unknown';
  const detectedMachine = req.query.detected || '';
  const choice = req.body.Digits || '';

  res.type('text/xml');

  if (choice === '2') {
    res.send(`
<Response>
  <Gather input="speech" action="/getMachine?name=${encodeURIComponent(name)}" method="POST" speechTimeout="auto" timeout="5">
    <Say>Please say the machine again.</Say>
  </Gather>
  <Say>I did not hear anything. Goodbye.</Say>
</Response>
`.trim());
    return;
  }

  if (!detectedMachine) {
    res.send(`
<Response>
  <Say>Sorry, we do not service that type of equipment.</Say>
  <Say>Please call again for supported machines. Goodbye.</Say>
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  <Gather input="speech" action="/getIssue?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(detectedMachine)}" method="POST" speechTimeout="auto" timeout="6">
    <Say>Got it. You said ${xmlEscape(detectedMachine)}.</Say>
    <Pause length="1"/>
    <Say>Please briefly describe the problem, like won't start, leaking, or making noise.</Say>
  </Gather>
  <Say>I did not hear anything. Goodbye.</Say>
</Response>
`.trim());
});

// ===== ISSUE =====
app.post('/getIssue', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = titleCase(req.body.SpeechResult);

  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="dtmf" numDigits="1" timeout="10" action="/checkIssue?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}" method="POST">
    <Say>I heard ${xmlEscape(issue)}. If this is correct, press 1. To say the problem again, press 2.</Say>
  </Gather>
  <Say>We did not receive a response. Goodbye.</Say>
</Response>
`.trim());
});

app.post('/checkIssue', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const choice = req.body.Digits || '';

  res.type('text/xml');

  if (choice === '2') {
    res.send(`
<Response>
  <Gather input="speech" action="/getIssue?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}" method="POST" speechTimeout="auto" timeout="6">
    <Say>Please say the problem again.</Say>
  </Gather>
  <Say>I did not hear anything. Goodbye.</Say>
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  <Gather input="dtmf" numDigits="5" timeout="10" action="/getZip?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}" method="POST">
    <Say>Please enter your five digit zip code using your keypad.</Say>
  </Gather>
  <Say>We did not receive your zip code. Goodbye.</Say>
</Response>
`.trim());
});

// ===== ZIP =====
app.post('/getZip', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = (req.body.Digits || '').slice(0, 5);
  const spokenZip = formatDigitsForSpeech(zip);

  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="dtmf" numDigits="1" timeout="10" action="/checkZip?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}" method="POST">
    <Say>You entered zip code ${spokenZip}. If this is correct, press 1. To re enter your zip code, press 2.</Say>
  </Gather>
  <Say>We did not receive a response. Goodbye.</Say>
</Response>
`.trim());
});

app.post('/checkZip', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || '';
  const choice = req.body.Digits || '';

  res.type('text/xml');

  if (choice === '2') {
    res.send(`
<Response>
  <Gather input="dtmf" numDigits="5" timeout="10" action="/getZip?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}" method="POST">
    <Say>Please re enter your five digit zip code using your keypad.</Say>
  </Gather>
  <Say>We did not receive your zip code. Goodbye.</Say>
</Response>
`.trim());
    return;
  }

  const matchedCounties = getCountyForZip(zip);

  if (matchedCounties.length === 0) {
    const spokenZip = formatDigitsForSpeech(zip);
    res.send(`
<Response>
  <Say>Sorry, we do not currently service zip code ${spokenZip}.</Say>
  <Say>Please leave your name, number, and message after the tone.</Say>
  <Record maxLength="60" action="/voicemail?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}" method="POST" />
  <Say>We did not receive a message. Goodbye.</Say>
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  <Say>Thank you. We do service your area.</Say>
  <Gather input="dtmf" numDigits="10" timeout="10" action="/getPhone?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}" method="POST">
    <Say>Please enter your ten digit phone number using your keypad.</Say>
  </Gather>
  <Say>We did not receive your phone number. Goodbye.</Say>
</Response>
`.trim());
});

// ===== PHONE =====
app.post('/getPhone', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const phone = (req.body.Digits || '').slice(0, 10);
  const spokenPhone = formatDigitsForSpeech(phone);

  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="dtmf" numDigits="1" timeout="10" action="/checkPhone?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}&amp;phone=${encodeURIComponent(phone)}" method="POST">
    <Say>You entered phone number ${spokenPhone}. If this is correct, press 1. To re enter your phone number, press 2.</Say>
  </Gather>
  <Say>We did not receive a response. Goodbye.</Say>
</Response>
`.trim());
});

app.post('/checkPhone', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const phone = req.query.phone || '';
  const choice = req.body.Digits || '';

  res.type('text/xml');

  if (choice === '2') {
    res.send(`
<Response>
  <Gather input="dtmf" numDigits="10" timeout="10" action="/getPhone?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}" method="POST">
    <Say>Please re enter your ten digit phone number using your keypad.</Say>
  </Gather>
  <Say>We did not receive your phone number. Goodbye.</Say>
</Response>
`.trim());
    return;
  }

  res.send(`
<Response>
  <Gather input="dtmf" numDigits="1" timeout="10" action="/getRequestType?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}&amp;phone=${encodeURIComponent(phone)}" method="POST">
    <Say>Press 1 to leave a message for follow up. Press 2 to request an appointment.</Say>
  </Gather>
  <Say>We did not receive a response. Goodbye.</Say>
</Response>
`.trim());
});

// ===== MESSAGE OR APPOINTMENT =====
app.post('/getRequestType', async (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const phone = req.query.phone || '';
  const choice = req.body.Digits || '';

  const requestType = choice === '2' ? 'Appointment Request' : 'Message';

  let serviceDate = '';
  let serviceDay = '';
  let serviceCounty = '';
  let serviceWindow = '';

  if (requestType === 'Appointment Request') {
    const routing = await findNextAvailableSlot(zip);

    if (routing) {
      serviceDate = routing.serviceDate;
      serviceDay = routing.serviceDay;
      serviceCounty = routing.serviceCounty;
      serviceWindow = routing.serviceWindow;
    }
  }

  const job = {
    id: generateJobId(),
    requestType,
    name,
    machine,
    problem: issue,
    zip,
    phone,
    serviceDate,
    serviceDay,
    serviceCounty,
    serviceWindow,
    time: new Date().toLocaleString()
  };

  saveJob(job);

  if (
    requestType === 'Appointment Request' &&
    serviceDate &&
    (serviceDay === 'Friday' || serviceDay === 'Saturday')
  ) {
    await rebalanceFridaySaturdayJobs(serviceDate);

    const updatedJobs = loadJobs();
    const saved = updatedJobs.find((j) => j.id === job.id);
    if (saved) {
      serviceWindow = saved.serviceWindow || serviceWindow;
      serviceCounty = saved.serviceCounty || serviceCounty;
    }
  }

  if (requestType === 'Appointment Request') {
    res.type('text/xml');
    res.send(`
<Response>
  <Say>Thank you. Your appointment request has been received.</Say>
  <Pause length="1"/>
  <Say>Your next available service day is ${xmlEscape(serviceDay || 'to be confirmed')}.</Say>
  <Pause length="1"/>
  <Say>Your service window is ${xmlEscape(serviceWindow || 'We will contact you to schedule your service window.')}.</Say>
  <Pause length="1"/>
  <Say>We will contact you if anything changes. Goodbye.</Say>
</Response>
`.trim());
    return;
  }

  res.type('text/xml');
  res.send(`
<Response>
  <Say>Thank you. Your message has been received. We will contact you shortly. Goodbye.</Say>
</Response>
`.trim());
});

// ===== OUT OF AREA VOICEMAIL =====
app.post('/voicemail', (req, res) => {
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
    time: new Date().toLocaleString()
  };

  saveJob(job);

  res.type('text/xml');
  res.send(`
<Response>
  <Say>Thank you. Your message has been recorded. Goodbye.</Say>
</Response>
`.trim());
});

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
    <div class="line">ZIP: ${job.zip || ''}</div>
    <div class="line">Phone: ${job.phone || ''}</div>
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
