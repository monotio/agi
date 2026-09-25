// Dev and test entry for ui-gallery.html; not a production build input.
import { createApp } from "vue";
import "../styles/tokens.css";
import UiGallery from "./UiGallery.vue";

createApp(UiGallery).mount("#gallery");
