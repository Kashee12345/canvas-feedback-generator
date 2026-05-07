const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Environment variables (set in Vercel)
const CANVAS_API_TOKEN = process.env.CANVAS_API_TOKEN;
const CANVAS_API_URL = 'https://nightingale.instructure.com/api/v1';
const COURSE_ID = 3611090;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Simple in-memory tracking (Vercel serverless, so resets between deploys)
// In production, use a database. For now, this tracks within the request.
const gradedStudents = new Set();

// Generate feedback using Claude API
async function generateFeedback(studentName, topic, score, missed) {
  const prompt = `You are Dr. Vidya Aggrawal, a pathophysiology instructor. Generate encouraging, practical feedback for this student on their quiz performance. Keep it to one paragraph, plain text, no formatting.

Student: ${studentName}
Topic: ${topic}
Score: ${score}
What they missed: ${missed}

Write feedback that:
1. Praises their overall performance
2. Explains the concept they missed in SIMPLE terms with an analogy or example
3. Explains what pitfalls to watch for
4. Encourages continued learning
5. Sign it "Dr Vidya Aggrawal"

Keep it simple and conversational.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 400,
        messages: [
          { role: 'user', content: prompt }
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.content[0].text;
  } catch (error) {
    console.error('Claude API error:', error);
    throw error;
  }
}

// Get quiz submission from Canvas
async function getQuizSubmission(assignmentId, studentId) {
  try {
    const response = await fetch(
      `${CANVAS_API_URL}/courses/${COURSE_ID}/assignments/${assignmentId}/submissions/${studentId}`,
      {
        headers: { 'Authorization': `Bearer ${CANVAS_API_TOKEN}` },
      }
    );

    if (!response.ok) {
      throw new Error(`Canvas API error: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Canvas submission fetch error:', error);
    throw error;
  }
}

// Post feedback to Canvas submission
async function postFeedbackToCanvas(assignmentId, studentId, feedback) {
  try {
    const response = await fetch(
      `${CANVAS_API_URL}/courses/${COURSE_ID}/assignments/${assignmentId}/submissions/${studentId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${CANVAS_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          comment: { text_comment: feedback },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Canvas API error: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Canvas feedback post error:', error);
    throw error;
  }
}

// Get all quiz submissions for an assignment
async function getQuizSubmissions(assignmentId) {
  try {
    const response = await fetch(
      `${CANVAS_API_URL}/courses/${COURSE_ID}/assignments/${assignmentId}/submissions?per_page=100`,
      {
        headers: { 'Authorization': `Bearer ${CANVAS_API_TOKEN}` },
      }
    );

    if (!response.ok) {
      throw new Error(`Canvas API error: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Canvas submissions fetch error:', error);
    throw error;
  }
}

// Check if submission already has a comment
function hasExistingFeedback(submission) {
  return submission.submission_comments && submission.submission_comments.length > 0;
}

// Main endpoint: Generate and post feedback
app.post('/api/generate-feedback', async (req, res) => {
  try {
    const { assignmentId, quizData } = req.body;

    if (!assignmentId || !quizData) {
      return res.status(400).json({ error: 'Missing assignmentId or quizData' });
    }

    // Fetch all submissions
    const submissions = await getQuizSubmissions(assignmentId);
    
    const results = {
      generated: [],
      skipped: [],
      errors: [],
      totalTokensUsed: 0,
    };

    // Process each submission
    for (const submission of submissions) {
      try {
        // Skip if no submission yet or already has feedback
        if (!submission.submitted_at || hasExistingFeedback(submission)) {
          results.skipped.push({
            studentId: submission.user_id,
            studentName: submission.user?.name || 'Unknown',
            reason: 'Already graded or no submission',
          });
          continue;
        }

        // Extract student data from quiz data
        const studentQuizData = quizData.find(q => 
          q.name.toLowerCase().includes(submission.user?.name?.toLowerCase() || '')
        );

        if (!studentQuizData) {
          results.skipped.push({
            studentId: submission.user_id,
            studentName: submission.user?.name || 'Unknown',
            reason: 'No quiz data provided',
          });
          continue;
        }

        // Generate feedback
        const feedback = await generateFeedback(
          submission.user?.name || 'Student',
          studentQuizData.topic || 'Quiz',
          studentQuizData.score || 'N/A',
          studentQuizData.missed || 'None specified'
        );

        // Post to Canvas
        await postFeedbackToCanvas(assignmentId, submission.user_id, feedback);

        results.generated.push({
          studentId: submission.user_id,
          studentName: submission.user?.name || 'Unknown',
          feedback: feedback,
        });

        // Estimate tokens used (~300 per feedback)
        results.totalTokensUsed += 300;

      } catch (error) {
        results.errors.push({
          studentId: submission.user_id,
          studentName: submission.user?.name || 'Unknown',
          error: error.message,
        });
      }
    }

    // Calculate cost (Claude API pricing)
    const estimatedCost = (results.totalTokensUsed * 0.015) / 1000;

    res.json({
      success: true,
      stats: {
        generated: results.generated.length,
        skipped: results.skipped.length,
        errors: results.errors.length,
        totalTokensUsed: results.totalTokensUsed,
        estimatedCost: estimatedCost.toFixed(2),
      },
      results: results,
    });

  } catch (error) {
    console.error('Feedback generation error:', error);
    res.status(500).json({
      error: 'Failed to generate feedback',
      details: error.message,
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Export for Vercel
module.exports = app;

// Local development
const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}