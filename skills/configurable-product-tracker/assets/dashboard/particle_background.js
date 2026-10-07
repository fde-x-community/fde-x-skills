'use strict';
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    typeof window.tsParticles !== 'undefined' && typeof window.loadSlim === 'function') {
  (async () => {
    await window.loadSlim(window.tsParticles);
    window.dashboardParticleContainer = await window.tsParticles.load({
      id: 'particle-background',
      options: {
        fullScreen: {enable: false},
        fpsLimit: 50,
        detectRetina: true,
        particles: {
          number: {value: 95, density: {enable: false}},
          paint: {fill: {color: {value: ['#2872bf', '#4c91d6', '#72ade2']}}},
          shape: {type: 'circle'},
          opacity: {value: {min: 0.55, max: 0.9}},
          size: {value: {min: 1.5, max: 3}},
          links: {enable: true, color: '#6da6d9', distance: 135, opacity: 0.22, width: 1},
          move: {enable: true, speed: 0.65, direction: 'none', outModes: {default: 'out'}}
        },
        interactivity: {
          detectsOn: 'window',
          events: {onHover: {enable: true, mode: ['grab', 'attract']}, resize: {enable: true}},
          modes: {
            grab: {distance: 185, links: {opacity: 0.65}},
            attract: {distance: 185, duration: 0.4, speed: 2}
          }
        }
      }
    });
  })().catch(error => console.warn('粒子背景未能启动：', error));
}
