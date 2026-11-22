import { render } from 'preact';
import { App } from './app';
import './styles.css';

const container = document.getElementById('app');
if (container) {
  render(<App />, container);
}
