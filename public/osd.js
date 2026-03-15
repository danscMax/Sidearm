const params = new URLSearchParams(window.location.search);
const name = params.get("name") || "Default";
document.getElementById("profile-name").textContent = name;
