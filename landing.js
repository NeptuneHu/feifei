const moods = [
  {id:'good', speech:'重点，肥肥递给你。', label:'偏暖时，开心一点'},
  {id:'bad', speech:'先看事实，慢一点也好。', label:'偏冷时，陪你看看'},
  {id:'uncertain', speech:'冷暖相间，先读原文。', label:'看不清时，想一想'}
];
let selected = 0;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
function setMood(index) {
  selected = index;
  const mood = moods[index];
  const img = document.querySelector('#hero-pig-image');
  img.src = `assets/pig/${mood.id}.png`;
  img.alt = `肥肥，${['开心','委屈','思考'][index]}表情`;
  document.querySelector('#hero-speech').textContent = mood.speech;
  document.querySelector('#mood-label').textContent = mood.label;
  document.querySelectorAll('[data-mood]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.mood) === index)));
  const pig = document.querySelector('#hero-pig');
  pig.getAnimations().forEach((animation) => animation.cancel());
  if (!reduced.matches) pig.animate([{scale:'.96'},{scale:'1.04',offset:.5},{scale:'1'}],{duration:420,easing:'cubic-bezier(.22,1,.36,1)'});
}
document.querySelectorAll('[data-mood]').forEach((button) => button.addEventListener('click', () => setMood(Number(button.dataset.mood))));
document.querySelector('#hero-pig').addEventListener('click', () => setMood((selected + 1) % moods.length));
// Retain old desktop-preview links after the introduction becomes the homepage.
if (new URLSearchParams(location.search).has('pet')) location.replace(`app.html${location.search}${location.hash}`);
