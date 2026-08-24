import type {FC} from 'react';

import './App.css';

const App: FC = () => {
  return (
    <main className="coming-soon">
      <div className="coming-soon__content">
        <div className="coming-soon__brand" aria-label="Mentra">
          <img src="/logo_new.svg" alt="" />
          <span>Mentra</span>
        </div>
        <h1>Mentra Miniapp Store for Mentra 3.0 is coming soon.</h1>
      </div>
    </main>
  )
};

export default App;
