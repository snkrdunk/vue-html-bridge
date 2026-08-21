<script setup lang="ts">
const props = defineProps<{ loggedIn: boolean }>();
</script>
<template>
  <nav v-if="props.loggedIn" id="user-menu" />
  <button :aria-controls="props.loggedIn ? 'missing' : undefined">Menu</button>
</template>
