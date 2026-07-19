import type { ModelConfig } from 'openfox/provider'

export function getDefaultModels(): ModelConfig[] {
  return [
    // Gemini 3.1 Pro (High performance variant, currently restricted/400)
    { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)', contextWindow: 200000, source: 'default' },
    // Gemini 3.1 Pro (Standard/low latency variant, fully functional)
    { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)', contextWindow: 200000, source: 'default' },
    // Gemini 3.1 Pro optimized for agent loops and tool calls
    { id: 'gemini-pro-agent', name: 'Gemini Pro Agent', contextWindow: 200000, source: 'default' },
    // Gemini 3 Flash (Standard fast model)
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 200000, source: 'default' },
    // Gemini 3 Flash optimized for agent loops and tool calls
    { id: 'gemini-3-flash-agent', name: 'Gemini 3 Flash Agent', contextWindow: 200000, source: 'default' },
    // Gemini 3.1 Flash Lite (Ultra-lightweight fast model, fully functional)
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextWindow: 200000, source: 'default' },
    // Gemini 3.1 Flash with multimodal/image capabilities
    { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image', contextWindow: 200000, source: 'default' },
    // Gemini 3.5 Flash (Medium latency/higher capability variant)
    { id: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash Low', contextWindow: 200000, source: 'default' },
    // Gemini 3.5 Flash (Extra low latency/lighter variant)
    { id: 'gemini-3.5-flash-extra-low', name: 'Gemini 3.5 Flash Extra Low', contextWindow: 200000, source: 'default' },
    // Gemini 2.5 Pro (Previous generation pro model, currently returning 503 side issue)
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 200000, source: 'default' },
    // Gemini 2.5 Flash (Previous generation standard model)
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 200000, source: 'default' },
    // Gemini 2.5 Flash Lite (Previous generation lightweight model)
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', contextWindow: 200000, source: 'default' },
    // Gemini 2.5 Flash with native reflection/thinking enabled
    { id: 'gemini-2.5-flash-thinking', name: 'Gemini 2.5 Flash (Thinking)', contextWindow: 200000, source: 'default' },
    // Anthropic Claude 3 Opus (Thinking variant, hosted via Google partner gateway)
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 Thinking', contextWindow: 200000, source: 'default' },
    // Anthropic Claude 3.5 Sonnet (New variant, hosted via Google partner gateway)
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, source: 'default' },
    // GPT-OSS 120B (Open-source large model, hosted via Google partner gateway)
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', contextWindow: 200000, source: 'default' },
    // Tab completion model based on Flash Lite (fast code suggestion)
    { id: 'tab_flash_lite_preview', name: 'tab_flash_lite_preview', contextWindow: 200000, source: 'default' },
    // Tab completion model with jump/FIM support based on Flash Lite
    { id: 'tab_jump_flash_lite_preview', name: 'tab_jump_flash_lite_preview', contextWindow: 200000, source: 'default' },
    // Experimental chat model build 20706 (currently restricted/400)
    { id: 'chat_20706', name: 'chat_20706', contextWindow: 200000, source: 'default' },
    // Experimental chat model build 23310 (currently restricted/400)
    { id: 'chat_23310', name: 'chat_23310', contextWindow: 200000, source: 'default' },
  ]
}
