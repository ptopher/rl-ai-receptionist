const express = require('express');
const fs = require('fs');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const JOBS_FILE = 'jobs.json';

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

// ===== WEEKLY COUNTY PLAN =====
const weeklyCountyPlan = {
  Monday: "Prince George's",
  Tuesday: "Howard",
  Wednesday: "Anne Arundel",
  Thursday: "Baltimore County",
  Friday: {
    morning: "Prince George's",
    afternoon: "Anne Arundel"
  },
  Saturday: {
    morning: "Howard",
    afternoon: "Baltimore County"
  }
};

const machineMap = {
  Lawnmower: [
    'lawn mower',
    'lawnmower',
    'mower',
    'push mower',
    'zero turn',
    'zeroturn'
  ],
  'Riding mower': [
    'riding mower',
    'ridingmower',
    'riding lawn mower',
    'ride mower',
    'lawn tractor',
    'rider'
  ],
  Generator: [
    'generator',
    'gen'
  ],
  'Pressure washer': [
    'pressure washer',
    'pressurewasher',
    'power washer',
    'powerwasher'
  ],
  Snowblower: [
    'snowblower',
    'snow blower',
    'snow thrower'
  ]
};

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
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function detectMachine(input) {
  const cleaned = cleanText(input);
  const compressed = cleaned.replace(/\s+/g, '');

  if (cleaned === 'riding mower' || compressed === 'ridingmower') {
    return 'Riding mower';
  }
  if (cleaned === 'lawn mower' || compressed === 'lawnmower' || cleaned === 'mower') {
    return 'Lawnmower';
  }
  if (cleaned === 'generator' || cleaned === 'gen') {
    return 'Generator';
  }
  if (
    cleaned === 'pressure washer' ||
    compressed === 'pressurewasher' ||
    cleaned === 'power washer' ||
    compressed === 'powerwasher'
  ) {
    return 'Pressure washer';
  }
  if (cleaned === 'snowblower' || cleaned === 'snow blower' || cleaned === 'snow thrower') {
    return 'Snowblower';
  }

  for (const machineName of Object.keys(machineMap)) {
    for (const phrase of machineMap[machineName]) {
      const phraseClean = cleanText(phrase);
      const phraseCompressed = phraseClean.replace(/\s+/g, '');

      if (cleaned.includes(phraseClean) || compressed.includes(phraseCompressed)) {
        return machineName;
      }
    }
  }

  return null;
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

function saveJob(job) {
  const jobs = loadJobs();
  jobs.push(job);
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
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

function getNextServiceDayName() {
  const now = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  for (let offset = 1; offset <= 7; offset += 1) {
    const future = new Date(now);
    future.setDate(now.getDate() + offset);
    const dayName = dayNames[future.getDay()];

    if (dayName !== 'Sunday') {
      return dayName;
    }
  }

  return 'Monday';
}

function getAppointmentWindow(zip) {
  const dayName = getNextServiceDayName();
  const matchingCounties = getCountyForZip(zip);
  const plan = weeklyCountyPlan[dayName];

  if (!plan) {
    return {
      dayName,
      county: matchingCounties[0] || 'Unknown',
      window: 'We will contact you to schedule your service window.',
      matched: false
    };
  }

  if (typeof plan === 'string') {
    const matched = matchingCounties.includes(plan);

    return {
      dayName,
      county: plan,
      window: matched ? '10:00 to 10:30' : 'We will contact you to schedule your service window.',
      matched
    };
  }

  if (typeof plan === 'object') {
    if (matchingCounties.includes(plan.morning)) {
      return {
        dayName,
        county: plan.morning,
        window: '10:00 to 12:00',
        matched: true
      };
    }

    if (matchingCounties.includes(plan.afternoon)) {
      return {
        dayName,
        county: plan.afternoon,
        window: '1:00 to 4:00',
        matched: true
      };
    }

    return {
      dayName,
      county: matchingCounties[0] || 'Unknown',
      window: 'We will contact you to schedule your service window.',
      matched: false
    };
  }

  return {
    dayName,
    county: matchingCounties[0] || 'Unknown',
    window: 'We will contact you to schedule your service window.',
    matched: false
  };
}

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

// ===== ROOT =====
app.get('/', (req, res) => {
  res.send('RL AI Receptionist is running');
});

// ===== START CALL =====
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
  const spokenMachine = req.query.spoken || 'Unknown';
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
app.post('/getRequestType', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const phone = req.query.phone || '';
  const choice = req.body.Digits || '';

  const requestType = choice === '2' ? 'Appointment Request' : 'Message';

  let serviceDay = '';
  let serviceCounty = '';
  let serviceWindow = '';

  if (requestType === 'Appointment Request') {
    const scheduling = getAppointmentWindow(zip);
    serviceDay = scheduling.dayName;
    serviceCounty = scheduling.county;
    serviceWindow = scheduling.window;
  }

  const job = {
    requestType,
    name,
    machine,
    problem: issue,
    zip,
    phone,
    serviceDay,
    serviceCounty,
    serviceWindow,
    time: new Date().toLocaleString()
  };

  saveJob(job);

  if (requestType === 'Appointment Request') {
    res.type('text/xml');
    res.send(`
<Response>
  <Say>Thank you. Your appointment request has been received.</Say>
  <Pause length="1"/>
  <Say>Your next available service day is ${xmlEscape(serviceDay)}.</Say>
  <Pause length="1"/>
  <Say>Your service window is ${xmlEscape(serviceWindow)}.</Say>
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

  let html = '<h1>Jobs</h1>';

  if (jobs.length === 0) {
    html += '<p>No jobs yet</p>';
    res.send(html);
    return;
  }

  html += '<ul>';

  jobs.forEach(job => {
    html += `<li>
      <strong>${job.time || ''}</strong><br>
      Type: ${job.requestType || ''}<br>
      Name: ${job.name || ''}<br>
      Machine: ${job.machine || ''}<br>
      Problem: ${job.problem || ''}<br>
      ZIP: ${job.zip || ''}<br>
      Phone: ${job.phone || ''}<br>
      ${job.serviceDay ? `Service Day: ${job.serviceDay}<br>` : ''}
      ${job.serviceCounty ? `County: ${job.serviceCounty}<br>` : ''}
      ${job.serviceWindow ? `Window: ${job.serviceWindow}<br>` : ''}
      ${job.recording ? `Recording: <a href="${job.recording}" target="_blank">Listen</a><br>` : ''}
    </li><br>`;
  });

  html += '</ul>';

  res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
