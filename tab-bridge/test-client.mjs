// Tab Bridge End-to-End Test Client
// Can test single-tab auto mode, multi-tab broadcast, and OpenAI compatibility!

import http from 'node:http';

const SERVER_URL = 'http://127.0.0.1:4040';

async function checkHealth() {
  console.log('🔍 Checking Tab Bridge Server Health...');
  try {
    const res = await fetch(`${SERVER_URL}/health`);
    const data = await res.json();
    console.log('✅ Server Status:', JSON.stringify(data, null, 2));
    return data;
  } catch (err) {
    console.error('❌ Server is not running! Please start the server with: npm start in /server');
    process.exit(1);
  }
}

async function testSingleTabPrompt(promptText = 'What is the speed of light? Respond in 1 sentence.') {
  console.log(`\n🚀 [TEST 1: Single-Tab Auto Mode] Sending prompt: "${promptText}"`);
  const startTime = Date.now();

  try {
    const res = await fetch(`${SERVER_URL}/api/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: promptText,
        provider: 'auto',
      }),
    });

    const data = await res.json();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [${data.provider?.toUpperCase()}] Replied in ${duration}s:`);
    console.log('--------------------------------------------------');
    console.log(data.reply);
    console.log('--------------------------------------------------\n');
  } catch (err) {
    console.error('❌ Error executing single prompt:', err);
  }
}

async function testOpenAiCompatible(promptText = 'Explain recursion in one sentence.') {
  console.log(`\n🤖 [TEST 2: OpenAI Compatible Endpoint] Calling /v1/chat/completions`);
  const startTime = Date.now();

  try {
    const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer dummy-key' },
      body: JSON.stringify({
        model: 'browser-auto',
        messages: [{ role: 'user', content: promptText }],
      }),
    });

    const data = await res.json();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ OpenAI format response (${duration}s):`);
    console.log('Choice 0 content:', data.choices?.[0]?.message?.content);
  } catch (err) {
    console.error('❌ Error calling OpenAI endpoint:', err);
  }
}

async function testMultiTabPrompt(promptText = 'Name 3 primary colors.') {
  console.log(`\n🌐 [TEST 3: Experimental Multi-Tab Broadcast] Sending to all open tabs: "${promptText}"`);

  try {
    const res = await fetch(`${SERVER_URL}/api/multi-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText }),
    });

    const data = await res.json();
    console.log('✅ Multi-Tab Results:');
    for (const [provider, result] of Object.entries(data.results || {})) {
      console.log(`\n--- [${provider.toUpperCase()}] ---`);
      console.log(result.reply || result.error);
    }
  } catch (err) {
    console.error('❌ Error executing multi-tab broadcast:', err);
  }
}

async function testAdvisorEndpoint() {
  console.log(`\n🛡️ [TEST 3: Advisor & Privacy Shield Handoff]`);
  console.log('Simulating local AI stuck on an error with local paths and secret token...');

  const sampleStuckTask = {
    task: 'Fix the Express authentication middleware token signing error',
    code: `const secret = "sk-proj-supersecretkey1234567890abcdef";\nconst file = "C:\\\\Users\\\\jack0\\\\Projects\\\\app\\\\server.ts";\nfunction verify(token) { return jwt.verify(token, secret); }`,
    error: 'TypeError: jwt.verify is not a function at Object.<anonymous> (C:\\Users\\jack0\\Projects\\app\\server.ts:14:2)',
    language: 'typescript'
  };

  try {
    const res = await fetch(`${SERVER_URL}/api/advisor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleStuckTask),
    });

    const data = await res.json();
    console.log(`✅ Advisor replied from ${data.provider?.toUpperCase()} (${(data.durationMs / 1000).toFixed(1)}s):`);
    console.log(`🛡️ Privacy Shield scrubbed: ${data.redactedSummary?.join(', ') || 'None'}`);
    console.log('--------------------------------------------------');
    console.log(data.advice);
    console.log('--------------------------------------------------');
    if (data.extractedCodeBlocks && data.extractedCodeBlocks.length > 0) {
      console.log(`\n📦 Extracted ${data.extractedCodeBlocks.length} clean code blocks ready for IDE insertion!`);
    }
  } catch (err) {
    console.error('❌ Error executing advisor test:', err);
  }
}

async function main() {
  const health = await checkHealth();
  if (health.connectedTabsCount === 0) {
    console.log('\n⚠️ No browser tabs currently connected.');
    console.log('👉 Please make sure:');
    console.log('1. The Chrome extension is loaded from: H:\\Projects\\tab-bridge\\extension');
    console.log('2. You have at least one tab open to ChatGPT, Claude, or Gemini in Chrome.\n');
    return;
  }

  // Run tests
  await testSingleTabPrompt();
  await testOpenAiCompatible();
  await testAdvisorEndpoint();
}

main();
