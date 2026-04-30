export class FootstepAudio {
  private context?: AudioContext;

  unlock() {
    this.context ??= new AudioContext();

    if (this.context.state !== 'running') {
      void this.context.resume();
    }
  }

  play(speedRatio: number) {
    if (!this.context || this.context.state !== 'running') {
      return;
    }

    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();

    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(115 + speedRatio * 45, now);
    oscillator.frequency.exponentialRampToValueAtTime(72, now + 0.075);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.045, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

    oscillator.connect(gain);
    gain.connect(this.context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.095);
  }
}
