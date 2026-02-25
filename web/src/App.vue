<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">xtctx</span>
        <span class="brand-sub">cross-tool context</span>
      </div>
      <nav class="nav">
        <RouterLink to="/">Dashboard</RouterLink>
        <RouterLink to="/search">Search</RouterLink>
        <RouterLink to="/knowledge">Knowledge</RouterLink>
        <RouterLink to="/sources">Sources</RouterLink>
        <RouterLink to="/config">Config</RouterLink>
      </nav>
    </header>

    <main class="content">
      <RouterView />
    </main>
  </div>
</template>
