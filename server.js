const express = require('express');
const fs = require('fs');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const serviceAreaZips = ['20724', '21054', '21113'];
const JOBS_FILE = 'jobs.json';

const allowedMachines = [
  'Lawnmower',
  'Riding mower',
  'Generator',
  'Pressure washer',
  'Snowblower'
];

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
    'riding lawn mower',
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

  for (const machineName of Object.keys(machineMap)) {
    for (const phrase of machineMap[machineName]) {
      if (cleaned.includes(phrase)) {
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
  const spokenMachine = titleCase(req.body.SpeechResult);

  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="dtmf" numDigits="1" timeout="10" action="/checkMachine?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(spokenMachine)}" method="POST">
    <Say>I heard ${xmlEscape(spokenMachine)}. If this is correct, press 1. To say the machine again, press 2.</Say>
  </Gather>
  <Say>We did not receive a response. Goodbye.</Say>
</Response>
`.trim());
});

app.post('/checkMachine', (req, res) => {
  const name = req.query.name || 'Unknown';
  const spokenMachine = req.query.machine || 'Unknown';
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

  const detectedMachine = detectMachine(spokenMachine);

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
    <Say>Got it. You said ${xmlEscape(detectedMachine)}. What problem are you having?</Say>
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

  if (!serviceAreaZips.includes(zip)) {
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

  const job = {
    requestType,
    name,
    machine,
    problem: issue,
    zip,
    phone,
    time: new Date().toLocaleString()
  };

  saveJob(job);

  res.type('text/xml');
  res.send(`
<Response>
  <Say>Thank you. Your ${requestType.toLowerCase()} has been received. We will contact you shortly. Goodbye.</Say>
</Response>
`.trim());
});

// ===== OUT OF AREA VOICEMAIL =====
app.post('/voicemail', (req, res) => {
  const job = {
    requestType: 'Out Of Area Voicemail',
    name: req.query.name || 'Unknown',
    machine: req.query.machine || 'Unknown',
    problem: req.query.issue || 'Unknown',
    zip: req.query.zip || 'Unknown',
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
