import { render, screen } from '@testing-library/react';
import React from 'react';
import App from './App';

describe('App Component', () => {
  it('renders the header correctly', () => {
    render(<App />);
    expect(screen.getByText('Screen Intelligence')).toBeInTheDocument();
    expect(screen.getByText('Real-time AI Vision & Voice Assistant')).toBeInTheDocument();
  });

  it('renders the Share Screen & Talk button', () => {
    render(<App />);
    expect(screen.getByText('Share Screen & Talk')).toBeInTheDocument();
  });
});
