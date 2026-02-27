import { createApp } from "vue";
import PrimeVue from "primevue/config";
import Aura from "@primeuix/themes/aura";
import App from "./App.vue";
import { useTheme } from "./composables/useTheme";
import "primeicons/primeicons.css";
import "./style.css";

useTheme();

createApp(App)
  .use(PrimeVue, {
    ripple: true,
    theme: {
      preset: Aura,
      options: {
        darkModeSelector: ".app-dark",
      },
    },
  })
  .mount("#app");
