import { Component, type ReactNode } from 'react';

// Ошибка отрисовки не должна оставлять пустой экран: показываем сообщение и даём перезагрузиться.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page" style={{ paddingBottom: 24 }}>
        <div className="page-head"><h1>Что-то пошло не так</h1></div>
        <p className="sub" style={{ marginBottom: 16 }}>Данные на устройстве не пострадали. {this.state.error.message}</p>
        <button className="btn primary block" onClick={() => { location.hash = '/calendar'; location.reload(); }}>Перезагрузить</button>
      </div>
    );
  }
}
