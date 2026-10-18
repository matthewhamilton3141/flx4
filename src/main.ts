import './style.css'
import { App } from './app.ts'
import { buildUI } from './ui/shell.ts'

const boot = document.getElementById('boot')!
try {
  const app = await App.create()
  buildUI(app)
  ;(window as unknown as { flx4: App }).flx4 = app // handy from the devtools console
  boot.remove()
  void app.loadDemos()
} catch (err) {
  boot.textContent = `Couldn't start the audio engine: ${(err as Error).message}. Try a current Chrome, Edge or Safari.`
}
