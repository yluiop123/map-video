import io

P = 'electron/main.mjs'
s = io.open(P, encoding='utf-8').read()

def rep(o, n):
    global s
    assert s.count(o) == 1, (s.count(o), repr(o[:70]))
    s = s.replace(o, n)


rep("""    case 'qwen-tts': {
      // 通义 CosyVoice（参照 createVideo/scripts）：POST /services/audio/tts/SpeechSynthesizer
      headers.Authorization = `Bearer ${cfg.apiKey}`;
      body = {
        model: cfg.model || 'cosyvoice-v3.5-flash',
        input: { text, voice: cfg.voice },
        parameters: { format: 'mp3', sample_rate: 24000 },
      };
      url += '/services/audio/tts/SpeechSynthesizer';
      break;
    }""",
"""    case 'cosyvoice': {
      // 通义 CosyVoice（参照 createVideo/scripts）：POST /services/audio/tts/SpeechSynthesizer
      headers.Authorization = `Bearer ${cfg.apiKey}`;
      body = {
        model: cfg.model || 'cosyvoice-v3-flash',
        input: { text, voice: cfg.voice },
        parameters: { format: 'mp3', sample_rate: 24000 },
      };
      url += '/services/audio/tts/SpeechSynthesizer';
      break;
    }
    case 'qwen-tts': {
      // Qwen-TTS 非实时合成：POST /services/aigc/multimodal-generation/generation
      // 模型名与音色与 CosyVoice 不通用（qwen3-tts-flash + Cherry 那套）
      headers.Authorization = `Bearer ${cfg.apiKey}`;
      body = {
        model: cfg.model || 'qwen3-tts-flash',
        input: { text, voice: cfg.voice || 'Cherry' },
      };
      url += '/services/aigc/multimodal-generation/generation';
      break;
    }""")

# 声音克隆：走 CosyVoice 的 enroll 服务
rep("if (protocol && protocol !== 'qwen-tts') return { audio: null, error: '声音克隆目前仅支持 DashScope CosyVoice' };",
    "if (protocol && protocol !== 'cosyvoice') return { audio: null, error: '声音克隆目前仅支持 DashScope CosyVoice' };")

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('ok main.mjs')
