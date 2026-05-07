const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

async function generateFeedback(name, topic, score, missed) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 400,
      messages: [{role: 'user', content: `You are Dr. Vidya Aggrawal. Generate one paragraph of encouraging feedback for ${name} on their ${topic} quiz (score: ${score}). They missed: ${missed}. Sign it "Dr Vidya Aggrawal". Keep it simple and conversational.`}],
    }),
  });
  const data = await response.json();
  return data.content[0].text;
}

app.post('/api/generate-feedback', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const {assignmentId, quizData} = req.body;
    const results = {generated: [], skipped: [], errors: [], totalTokensUsed: 0};
    
    for (const q of quizData) {
      try {
        const feedback = await generateFeedback(q.name, q.topic, q.score, q.missed);
        results.generated.push({studentName: q.name, feedback});
        results.totalTokensUsed += 300;
      } catch (e) {
        results.errors.push({studentName: q.name, error: e.message});
      }
    }
    
    res.json({success: true, stats: {generated: results.generated.length, skipped: 0, errors: results.errors.length, totalTokensUsed: results.totalTokensUsed, estimatedCost: ((results.totalTokensUsed * 0.015) / 1000).toFixed(2)}, results});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

module.exports = app;
