// LandingPage.tsx
import React from 'react';
import { Button } from '../components/ui/button';
import { useNavigate } from 'react-router-dom';

const LandingPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="">
        <div className=" mx-auto px-5 py-4 flex items-center justify-between">
          <div className='select-none'>
            <div className="flex items-end gap-0">
              <h1 className="font-cuprum font-bold text-5xl">.\</h1>
              <h1 className="font-light text-2xl pb-0.5 pl-1">ugment</h1>
              <h1 className="font-medium text-2xl pb-0.5">OS</h1>
            </div>
            <h2 className="text-sm text-gray-600 pb-1 ">Developer Portal</h2>
          </div>

          <div className="flex items-center gap-4">
            <Button onClick={()=> navigate("signin")}>Sign In</Button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="py-20 bg-gradient-to-b from-white to-gray-100 my-0 flex items-center">
        <div className="container mx-auto px-4 text-center">
          <div className="flex items-center justify-center mb-10">
            <img src="/g1.webp" alt="Hero" className="w-96" />
          </div>
          <h1 className="text-4xl md:text-6xl font-bold mb-6">
            AugmentOS is the best way to build apps for smart glasses.
          </h1>
          <p className="text-xl md:text-2xl text-gray-600 mb-10 max-w-3xl mx-auto">
            Build and deploy your own apps for smart glasses in minutes, not months.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <a
              href="/signin"
              className="px-6 py-3 rounded-md bg-black text-white font-medium hover:bg-stone-900 inline-flex items-center justify-center gap-2"
            >
              Developer Console
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10.293 5.293a1 1 0 011.414 0l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414-1.414L12.586 11H5a1 1 0 110-2h7.586l-2.293-2.293a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </a>
            <a
              href="https://docs.augmentos.org"
              className="px-6 py-3 rounded-md border border-gray-300 font-medium hover:bg-gray-100"
            >
              View Documentation
            </a>
          </div>

        </div>
      </section>

      {/* Getting Started Steps */}
      <section className="py-20 bg-gray-100">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl md:text-4xl font-bold mb-10 text-center">
            Start Building in 3 Simple Steps
          </h2>
          <div className="max-w-3xl mx-auto">
            <div className="flex flex-col md:flex-row gap-8">
              <div className="flex-1">
                <div className="border bg-white rounded-lg p-6 h-full">
                  <h3 className="text-xl font-medium mb-2">Register</h3>
                  <p className="text-gray-600">
                    Create a free developer account.
                  </p>
                </div>
              </div>
              <div className="flex-1">
                <div className="border bg-white rounded-lg p-6 h-full">
                  <h3 className="text-xl font-medium mb-2">Create</h3>
                  <p className="text-gray-600">
                    Define your app using our simple web interface.
                  </p>
                </div>
              </div>
              <div className="flex-1">
                <div className="border bg-white rounded-lg p-6 h-full">
                  <h3 className="text-xl font-medium mb-2">Code</h3>
                  <p className="text-gray-600">
                    Use our TypeScript SDK to bring your idea to life.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Featured Example TPAs */}
      <section className="py-20 bg-gray-100">
        {/* <div className="container mx-auto px-4">
          <h2 className="text-3xl md:text-4xl font-bold mb-10 text-center">
            Featured Example TPAs
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">

            <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
              <div className="h-40 bg-gradient-to-r from-blue-500 to-purple-500 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                </svg>
              </div>
              <div className="p-4">
                <h3 className="font-medium text-lg mb-1">Weather App</h3>
                <p className="text-sm text-gray-600">Real-time weather updates right in your field of view</p>
              </div>
            </div>


            <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
              <div className="h-40 bg-gradient-to-r from-green-500 to-teal-500 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div className="p-4">
                <h3 className="font-medium text-lg mb-1">Notes App</h3>
                <p className="text-sm text-gray-600">Voice-controlled note taking for hands-free productivity</p>
              </div>
            </div>

  
            <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
              <div className="h-40 bg-gradient-to-r from-red-500 to-orange-500 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
              <div className="p-4">
                <h3 className="font-medium text-lg mb-1">Fitness App</h3>
                <p className="text-sm text-gray-600">Track workouts and view stats without touching your phone</p>
              </div>
            </div>
          </div>
        </div> */}
      </section>

      {/* Footer */}
      <footer className="bg-gray-100 py-12 mt-auto">
        <div className="container mx-auto px-4">
          <div className="flex flex-col md:flex-row justify-between">
            <div className="mb-6 md:mb-0">
              <div className="flex items-center gap-2">
                <span className="font-bold">AugmentOS</span>
              </div>
              <p className="mt-2 text-sm text-gray-600 max-w-xs">
                The open source operating system for smart glasses.
              </p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-8">
              <div>
                {/* <h4 className="font-medium mb-3">Platform</h4>
                <ul className="space-y-2 text-sm">
                  <li><a href="#" className="text-gray-600 hover:text-gray-900">Features</a></li>
                  <li><a href="#" className="text-gray-600 hover:text-gray-900">SDK</a></li>
                </ul> */}
              </div>
              <div>
                <h4 className="font-medium mb-3">Resources</h4>
                <ul className="space-y-2 text-sm">
                  <li><a href="https://docs.augmentos.org" className="text-gray-600 hover:text-gray-900">Documentation</a></li>
                  <li><a href="https://github.com/AugmentOS-Community/AugmentOS-Cloud-Example-App" className="text-gray-600 hover:text-gray-900">Example App</a></li>
                </ul>
              </div>
              {/* <div>
                <h4 className="font-medium mb-3">Company</h4>
                <ul className="space-y-2 text-sm">
                  <li><a href="#" className="text-gray-600 hover:text-gray-900">About</a></li>
                  <li><a href="#" className="text-gray-600 hover:text-gray-900">Contact</a></li>
                </ul>
              </div> */}
            </div>
          </div>
          <div className="mt-12 pt-8 border-t border-gray-200 text-center text-sm text-gray-600">
            &copy; {new Date().getFullYear()} AugmentOS. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;