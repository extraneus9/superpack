const edge = document.getElementById('edge');
window.edgeLight.onFlash((list) => {
  const c = [].concat(list);
  edge.style.setProperty('--c', c[0]); edge.style.setProperty('--c2', c[1] || c[0]); edge.style.setProperty('--c3', c[2] || c[0]); edge.style.setProperty('--c4', c[3] || c[1] || c[0]);
  edge.classList.remove('on'); void edge.offsetWidth; edge.classList.add('on');
});
