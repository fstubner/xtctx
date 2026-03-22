import { createRouter, createWebHistory } from "vue-router";
import ActivityPage from "./pages/Activity.vue";
import DashboardPage from "./pages/Dashboard.vue";
import MemoryPage from "./pages/Memory.vue";
import ToolsPage from "./pages/Tools.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "dashboard", component: DashboardPage },
    { path: "/tools", name: "tools", component: ToolsPage },
    { path: "/memory", name: "memory", component: MemoryPage },
    { path: "/activity", name: "activity", component: ActivityPage },
    // Redirects from removed routes
    { path: "/sources", redirect: "/tools" },
    { path: "/knowledge", redirect: "/memory" },
    { path: "/search", redirect: "/memory" },
    { path: "/config", redirect: "/tools" },
  ],
});

export default router;
