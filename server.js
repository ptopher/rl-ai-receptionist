const express = require('express');
const fs = require('fs');
const app = express();

app.use(express.urlencoded({ extended: false }));

let currentCall = {};

function saveJob(job) {
  let jobs = [];

  if (fs.existsSync('jobs.json')) {
    jobs = JSON.parse(fs.readFileSync('jobs.json', 'utf8'));
  }

  jobs.push(job);

  fs.writeFileSync('jobs.json', JSON.stringify(jobs, null, 2));
}

app.get('/', (req, res) => {
  res.send('RL AI Receptionist is running');
});

app.post('/voice', (req, res) => {
  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="speech" action="/machine" method="POST">
    <Say>Please say your name</Say>
  </Gather>
</Response>
`);
});

app.post('/machine', (req, res) => {
  const name = req.body.SpeechResult || '';
  currentCall = { name };

  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="speech" action="/problem" method="POST">
    <Say>Please say the type of equipment</Say>
  </Gather>
</Response>
`);
});

app.post('/problem', (req, res) => {
  const machine = req.body.SpeechResult || '';
  currentCall.machine = machine;

  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="speech" action="/zip" method="POST">
    <Say>Please describe the problem</Say>
  </Gather>
</Response>
`);
});

app.post('/zip', (req, res) => {
  const problem = req.body.SpeechResult || '';
  currentCall.problem = problem;

  res.type('text/xml');
  res.send(`
<Response>
  <Gather input="dtmf" numDigits="5" action="/save" method="POST">
    <Say>Please enter your zip code</Say>
  </Gather>
</Response>
`);
});

app.post('/save', (req, res) => {
  const zip = req.body.Digits || '';

  const job = {
    name: currentCall.name || 'Unknown',
    machine: currentCall.machine || 'Unknown',
    problem: currentCall.problem || 'Unknown',
    zip: zip,
    time: new Date().toLocaleString()
  };

  saveJob(job);
  currentCall = {};

  res.type('text/xml');
  res.send(`
<Response>
  <Say>Thank you. Your request has been received.</Say>
</Response>
`);
});

app.get('/jobs', (req, res) => {
  if (!fs.existsSync('jobs.json')) {
    return res.send('<h1>No jobs yet</h1>');
  }

  const jobs = JSON.parse(fs.readFileSync('jobs.json', 'utf8'));

  let html = '<h1>Jobs</h1><ul>';

  jobs.forEach(j => {
    html += `<li>
      <strong>${j.time}</strong><br>
      Name: ${j.name}<br>
      ZIP: ${j.zip}<br>
      Machine: ${j.machine}<br>
      Problem: ${j.problem}<br>
    </li><br>`;
  });

  html += '</ul>';

  res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
