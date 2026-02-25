import { createRouter, createWebHistory } from "vue-router";
import ConfigPage from "./pages/Config.vue";
import DashboardPage from "./pages/Dashboard.vue";
import KnowledgePage from "./pages/Knowledge.vue";
import SearchPage from "./pages/Search.vue";
import SourcesPage from "./pages/Sources.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "dashboard", component: DashboardPage },
    { path: "/search", name: "search", component: SearchPage },
    { path: "/knowledge", name: "knowledge", component: KnowledgePage },
    { path: "/sources", name: "sources", component: SourcesPage },
    { path: "/config", name: "config", component: ConfigPage },
  ],
});

export default router;
