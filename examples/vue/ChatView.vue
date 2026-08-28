<!--
  A minimal chat component built on useLoopChat.ts — the piece that
  answers "okay, but what does an approval/question card actually look
  like in Vue." Renders `pending` as one of two card shapes depending on
  its own `type` discriminant, same narrowing the composable's own
  approve/deny/answer already rely on. Same structure as
  examples/react/ChatView.tsx, template `v-if`/`v-else-if` standing in for
  JSX's `&&` branches.

  Illustrative only — see useLoopChat.ts's own header comment for why this
  lives outside tsconfig.json's `include` globs.
-->
<script setup lang="ts">
import { ref } from 'vue'
import { useLoopChat } from './useLoopChat.js'

const props = defineProps<{ baseUrl: string; agent: string }>()
const { messages, pending, isStreaming, error, send, approve, deny, answer } = useLoopChat(props)

const draft = ref('')
const answerDraft = ref('')

function submit() {
  if (!draft.value.trim()) return
  send(draft.value)
  draft.value = ''
}

function submitAnswer() {
  if (!answerDraft.value.trim()) return
  answer(answerDraft.value)
  answerDraft.value = ''
}
</script>

<template>
  <div class="chat">
    <div class="chat-messages">
      <div v-for="(m, i) in messages" :key="i" :class="['msg', `msg-${m.role}`]">{{ m.text }}</div>

      <div v-if="pending?.type === 'approval:pending'" class="card card-approval">
        <div class="card-label">approval needed</div>
        <div class="card-tool">{{ pending.tool }}</div>
        <div class="card-reason">{{ pending.reason }}</div>
        <pre class="card-args">{{ JSON.stringify(pending.args, null, 2) }}</pre>
        <div class="card-actions">
          <button class="approve" @click="approve">Approve</button>
          <button class="deny" @click="deny">Deny</button>
        </div>
      </div>

      <div v-else-if="pending?.type === 'question:pending'" class="card card-question">
        <div class="card-label">answer needed</div>
        <div class="card-question-text">{{ pending.question }}</div>
        <div v-if="pending.options && pending.options.length" class="card-options">
          <button v-for="option in pending.options" :key="option" @click="answer(option)">{{ option }}</button>
        </div>
        <div class="card-answer-row">
          <input v-model="answerDraft" placeholder="Type an answer…" @keydown.enter="submitAnswer" />
          <button @click="submitAnswer">Send</button>
        </div>
      </div>

      <div v-if="isStreaming && !pending" class="msg msg-thinking">…</div>
      <div v-if="error" class="msg msg-error">{{ error }}</div>
    </div>

    <div class="chat-input">
      <input v-model="draft" :disabled="isStreaming" placeholder="Message…" @keydown.enter="submit" />
      <button :disabled="isStreaming || !draft.trim()" @click="submit">Send</button>
    </div>
  </div>
</template>
