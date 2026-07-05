//Components
import SearchBar from "./searchBar.jsx"
import { NotificationMenu } from "../modal/headerModalsComponents/notificationsMenu/NotificationMenu.jsx";
import { UserMenu } from "../../user/UserMenu.jsx";
import { useModal } from '../../common/modal/ModalContext';

//Icons
import { FaCirclePlus, FaMicrophone, FaArrowLeft } from "react-icons/fa6";
import { ImSearch } from "react-icons/im";
//Router
import { Link, useNavigate } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
//Hooks
import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../../../public/auth/AuthContext.jsx';

export function CatubeHeader({ logo, searchQuery, setSearchQuery }) {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const { isAuthenticated } = useAuth();
    const isRegisterPage = pathname.includes('/register');

    // Local state for search query if not provided
    const [localSearchQuery, setLocalSearchQuery] = useState('');

    // Use provided or local
    const currentSearchQuery = searchQuery !== undefined ? searchQuery : localSearchQuery;
    const currentSetSearchQuery = setSearchQuery || setLocalSearchQuery;

    const isSearchEmpty = !currentSearchQuery || currentSearchQuery.trim() === '';

    // Voice search states
    const [isListening, setIsListening] = useState(false);
    const [placeholder, setPlaceholder] = useState("Search...");

    // Mobile search state
    const [showMobileSearch, setShowMobileSearch] = useState(false);
    const headerRef = useRef(null);

    //Conditional classes and visibility
    const cardClassName = isRegisterPage
        ? 'sr-header-right register'
        : 'sr-header-right';

    const showSearchBar = !isRegisterPage;

    const { openModal } = useModal();

    // Close mobile search on resize if screen becomes large
    useEffect(() => {
        const handleResize = () => {
            if (window.innerWidth > 680) {
                setShowMobileSearch(false);
            }
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Close mobile search when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (showMobileSearch && headerRef.current && !headerRef.current.contains(event.target)) {
                setShowMobileSearch(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showMobileSearch]);


    const handleVoiceSearch = () => {
        // console.log('Voice search started');
        let finalSearchTranscript = '';
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.error('SpeechRecognition not supported');
            return;
        }
        if (!currentSetSearchQuery) {
            console.error('setSearchQuery not available');
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'es-ES';

        recognition.onstart = () => {
            setIsListening(true);
            setPlaceholder("Listening...");
        };

        recognition.onresult = (e) => {
            let interimTranscript = '';
            let finalTranscript = '';
            for (let i = 0; i < e.results.length; i++) {
                const transcript = e.results[i][0].transcript;
                if (e.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }
            currentSetSearchQuery(finalTranscript + interimTranscript);
            finalSearchTranscript = finalTranscript;
        };

        recognition.onend = () => {
            setIsListening(false);
            setPlaceholder("Search...");
            let cleanedTranscript = finalSearchTranscript.trim();
            cleanedTranscript = cleanedTranscript.replace(/\.$/, '');
            if (cleanedTranscript) {
                const searchPagePath = '/Search';
                if (pathname.includes(searchPagePath)) {
                    currentSetSearchQuery(cleanedTranscript);
                    // Update URL query param if already on search page
                    navigate(`${searchPagePath}?q=${encodeURIComponent(cleanedTranscript)}`, { replace: true });
                } else {
                    navigate(`${searchPagePath}?q=${encodeURIComponent(cleanedTranscript)}`);
                }
            }
        };

        recognition.onerror = (e) => {
            setIsListening(false);
            setPlaceholder("Error, intenta de nuevo");
            console.error("Error en Speech Recognition: ", e.error);
        };

        recognition.start();
    };

    const handleSearchSubmit = () => {
        if (isSearchEmpty) {
            return;
        }
        const searchPagePath = '/Search';
        if (!pathname.includes(searchPagePath)) {
            navigate(`${searchPagePath}?q=${encodeURIComponent(currentSearchQuery)}`);
        } else {
            navigate(`${searchPagePath}?q=${encodeURIComponent(currentSearchQuery)}`, { replace: true });
        }
        setShowMobileSearch(false);
    };

    const handleSearchToggleOrSubmit = () => {
        if (window.innerWidth <= 680) {
            setShowMobileSearch(true);
        } else {
            handleSearchSubmit();
        }
    };

    return (
        <header className="sr-header" ref={headerRef}>
            {showMobileSearch ? (
                <div className="sr-header-mobile-search-overlay">
                    <button className="sr-header-back-button" onClick={() => setShowMobileSearch(false)}>
                        <FaArrowLeft size={20} />
                    </button>
                    <div className="sr-header-searchBarSection mobile-expanded">
                        <SearchBar
                            className="sr-header-input mobile-input"
                            searchQuery={currentSearchQuery}
                            setSearchQuery={currentSetSearchQuery}
                            placeholder={placeholder}
                            disabled={isSearchEmpty}
                        />
                        <button className="sr-header-searchButton mobile-search-btn" onClick={handleSearchSubmit}>
                            <ImSearch size={20} />
                        </button>
                    </div>
                    <button
                        className={`sr-header-micButton mobile-mic ${isListening ? 'listening' : ''}`}
                        onClick={handleVoiceSearch}
                    >
                        <FaMicrophone size={20} />
                    </button>
                </div>
            ) : (
                <>
                    <Link to={`/`}>
                        <div className="sr-header-logo">
                            <img className="sr-header-symbol" src={logo} alt={`Logo de Catube`} />
                            <span className="sr-header-title">CaTube</span>
                        </div>
                    </Link>

                    {showSearchBar && (
                        <div className="sr-header-searchBar">
                            <button
                                className={`sr-header-micButton ${isListening ? 'listening' : ''}`}
                                onClick={handleVoiceSearch}
                            >
                                <FaMicrophone size={20} />
                            </button>
                            <div className="sr-header-searchBarSection">
                                <SearchBar
                                    className="sr-header-input"
                                    searchQuery={currentSearchQuery}
                                    setSearchQuery={currentSetSearchQuery}
                                    placeholder={placeholder}
                                    disabled={isSearchEmpty}
                                />
                                <button className="sr-header-searchButton" onClick={handleSearchToggleOrSubmit}>
                                    <ImSearch size={20} />
                                </button>
                            </div>
                        </div>
                    )}

                    <div className={cardClassName}>
                        {isAuthenticated && (
                            <button className="sr-header-createButton" onClick={() => openModal('createvideo')}>
                                <span className="sr-header-createLabel">Create</span>
                                <FaCirclePlus color={"#f08c52"} size={28} />
                            </button>
                        )}
                        <div className="sr-header-userActions">
                            {isAuthenticated && <NotificationMenu />}
                            <UserMenu />
                        </div>
                    </div>
                </>
            )}
        </header>
    );
}
