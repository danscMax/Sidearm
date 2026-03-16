import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ru from "./locales/ru.json";
import en from "./locales/en.json";

const savedLang = localStorage.getItem("sidearm-language") ?? "ru";

void i18n.use(initReactI18next).init({
  resources: {
    ru: { translation: ru },
    en: { translation: en },
  },
  lng: savedLang,
  fallbackLng: "ru",
  interpolation: { escapeValue: false },
});

export function changeLanguage(lang: string) {
  localStorage.setItem("sidearm-language", lang);
  void i18n.changeLanguage(lang);
}

export default i18n;
