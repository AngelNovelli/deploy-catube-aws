import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSidebarToggle } from '../../../hooks/useSidebarToggleFriends';
import { useToast } from '../../../hooks/useToast';
import { useModal } from '../../common/modal/ModalContext';
import { useAuth } from '../../../../public/auth/AuthContext';

// Importaciones de iconos
import { IoArrowBackCircle } from "react-icons/io5";
import { IoIosCloseCircle } from "react-icons/io";
import { FaUserFriends } from "react-icons/fa";

import FriendProfileView from './FriendProfileView';
import FriendChatView from './FriendChatView';
import MyProfileView from './MyProfileView';
import FriendCard from './FriendCard';
import FriendRequestCard from './FriendRequestCard';
import Loader from '../Loader';

// Importaciones de tus funciones de API
import {
    fetchUsers,
    fetchFriendsAndRequests,
    sendFriendRequest,
    fetchMyProfile,
    updateMyProfile,
    deleteFriendship,
    acceptFriendRequest,
    rejectFriendRequest,
} from './friendShipApi';

// Importaciones de constantes y utilidades
import { getAuthToken } from '../../../utils/auth';

import './friendMenu.css';

export function FriendMenu() {
    const { isAuthenticated, user } = useAuth();
    const { isFriendMenuOpen, toggleFriendMenu, closeFriendMenu } = useSidebarToggle();
    const collapsedClass = !isFriendMenuOpen ? 'collapsed' : '';

    // 1. REFERENCIA PARA EL CONTENEDOR DEL MENÚ
    const menuRef = useRef(null);

    // --- ESTADOS DE LA VISTA Y DATOS ---
    const [userStatus, setUserStatus] = useState('online');
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [currentView, setCurrentView] = useState('list');
    const [selectedFriend, setSelectedFriend] = useState(null);

    // ESTADOS CENTRALES DE AMISTAD
    const [friends, setFriends] = useState([]);
    const [pendingRequests, setPendingRequests] = useState([]);
    const [searchResults, setSearchResults] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSearchLoading, setIsSearchLoading] = useState(false);

    // ESTADO PARA MI PERFIL
    const [myProfile, setMyProfile] = useState(null);

    // Referencia para guardar las IDs de solicitudes pendientes de la última carga
    const previousPendingRequestIds = useRef(new Set());

    const lastSearchQueryRef = useRef('');

    // REFERENCIA PARA ACCEDER A LOS DATOS DE AMISTAD EN CALLBACKS
    const friendDataRef = useRef({ friends: [], pendingRequests: [] });

    // FeedbackToast y Modal Context y Notificaciones
    const { showSuccess, showError } = useToast();
    const { openModal, closeModal } = useModal();

    // Referencia para almacenar las funciones de hook (para estabilizar loadData)
    const hookFuncsRef = useRef({ showError });

    // Actualizamos el ref en cada renderizado.
    useEffect(() => {
        hookFuncsRef.current.showError = showError;
    });

    // Reset state when user changes or logs out
    useEffect(() => {
        if (!isAuthenticated || !user) {
            setFriends([]);
            setPendingRequests([]);
            setSearchResults([]);
            setMyProfile(null);
            setSearchQuery('');
            setSelectedFriend(null);
            setCurrentView('list');
            previousPendingRequestIds.current = new Set();
            friendDataRef.current = { friends: [], pendingRequests: [] };
        }
    }, [isAuthenticated, user]);

    useEffect(() => {
        friendDataRef.current.friends = friends;
        friendDataRef.current.pendingRequests = pendingRequests;
    }, [friends, pendingRequests]);

    // Derivados de estado
    const friendIds = useMemo(() => new Set(friends.map(f => f.id)), [friends]);
    const isSearching = searchQuery.length > 0;

    // 2. LÓGICA DE CLICK-OUTSIDE
    useEffect(() => {
        // Solo adjuntamos el listener si el menú está abierto
        if (!isFriendMenuOpen) return;

        const handleClickOutside = (event) => {
            // Referencia para el contenedor del Modal (ajusta la clase o ID según tu implementación)
            const modalRoot = document.querySelector('.universal-modal-content') || document.getElementById('modal-root');

            if (modalRoot && modalRoot.contains(event.target)) {
                return;
            }

            if (menuRef.current && !menuRef.current.contains(event.target)) {
                closeFriendMenu();
            }
        };

        // Adjunta el event listener al documento. 
        document.addEventListener("mousedown", handleClickOutside);

        // Función de limpieza
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [isFriendMenuOpen, closeFriendMenu]); // Dependencias estables.

    // --- LÓGICA DE CARGA DE AMIGOS/SOLICITUDES (FUNCIÓN ESTABLE) ---
    const loadFriendsAndRequests = useCallback(async () => {
        const { showError: currentShowError } = hookFuncsRef.current;
        if (!isAuthenticated) return;

        try {
            const friendData = await fetchFriendsAndRequests();

            const visibleRequests = friendData.pendingRequests;
            setPendingRequests(visibleRequests);

            const currentRequestIds = new Set(friendData.pendingRequests.map(req => req.id));

            const newRequests = friendData.pendingRequests.filter(
                req => !previousPendingRequestIds.current.has(req.id)
            );

            previousPendingRequestIds.current = currentRequestIds;
            // Estabilizar Friends
            setFriends(prevFriends => {
                if (prevFriends.length !== friendData.friends.length) return friendData.friends;

                const isSame = prevFriends.every((f, i) => String(f.id) === String(friendData.friends[i].id));

                return isSame ? prevFriends : friendData.friends;
            });

            // Estabilizar PendingRequests
            setPendingRequests(prevRequests => {
                if (prevRequests.length !== friendData.pendingRequests.length) return friendData.pendingRequests;

                const isSame = prevRequests.every((req, i) => String(req.id) === String(friendData.pendingRequests[i].id));

                return isSame ? prevRequests : friendData.pendingRequests;
            });


        } catch (error) {
            console.error("Error al cargar datos de amistad:", error);
            currentShowError("Failed to load friend data.");
        }
    }, [setFriends, setPendingRequests, isAuthenticated]); // Los setters son estables

    // --- LÓGICA DE CARGA DE MI PERFIL (UNA SOLA VEZ) ---
    useEffect(() => {
        let isMounted = true;
        if (!isAuthenticated) return;

        const loadProfile = async () => {
            // Seteamos isLoading *antes* de la primera carga para mostrar un estado inicial
            setIsLoading(true);
            try {
                const profileData = await fetchMyProfile();
                if (isMounted) setMyProfile(profileData);
            } catch (error) {
                console.warn("Could not load user profile details.", error.message);
                if (isMounted) setMyProfile({ userName: "Guest", description: "Profile not loaded" });
            } finally {
                if (isMounted) setIsLoading(false);
            }
        };

        loadProfile();

        return () => {
            isMounted = false;
        };
    }, [isAuthenticated, setMyProfile, setIsLoading]); // Dependencias estables.

    // --- EFECTO DE CARGA INICIAL Y INTERVALO (USA loadFriendsAndRequests) ---
    useEffect(() => {
        let isMounted = true;

        // Función de carga completa que solo llama a la API de Amigos/Solicitudes
        const initialAndIntervalLoad = async () => {
            if (isMounted && isAuthenticated) {
                await loadFriendsAndRequests();
            }
        };

        // Primera carga inmediata
        initialAndIntervalLoad();

        // Intervalo para refrescar
        const intervalId = setInterval(initialAndIntervalLoad, 15000); // 15 segundos

        return () => {
            isMounted = false;
            clearInterval(intervalId); // Limpia el intervalo al desmontar el componente
        };
    }, [loadFriendsAndRequests, isAuthenticated]); // Dependencias: loadFriendsAndRequests es estable.


    // ***************************************************************
    // --- LÓGICA DE BÚSQUEDA EN TIEMPO REAL (DEBOUNCING) ---
    // ***************************************************************

    // Función que llama a la API de búsqueda
    const executeSearch = useCallback(async (query) => {
        const trimmedQuery = query.trim();

        if (trimmedQuery.length < 2) {
            setSearchResults([]);
            setIsSearchLoading(false);
            return;
        }

        setIsSearchLoading(true);

        try {
            const results = await fetchUsers(trimmedQuery);

            // -----------------------------------------------------------------

            const currentFriends = friendDataRef.current.friends;
            const currentPendingRequests = friendDataRef.current.pendingRequests;

            // Filtrar resultados
            const existingIds = new Set([
                ...currentFriends.map(f => f.id),
                ...currentPendingRequests.map(req => req.sender.id)
            ]);
            const myId = myProfile?.id;

            // El filtrado ahora usa user.id, que fue mapeado.
            const filteredResults = results.filter(user =>
                !existingIds.has(user.id) && user.id !== myId
            );


            // Estabilización: solo actualiza si los resultados son REALMENTE diferentes
            setSearchResults(prev => {
                if (prev.length !== filteredResults.length) {
                    return filteredResults;
                }
                if (prev.length === 0) {
                    return prev;
                }
                const isSame = prev.every((item, index) => String(item.id) === String(filteredResults[index].id));

                return isSame ? prev : filteredResults;
            });

            lastSearchQueryRef.current = trimmedQuery;

        } catch (error) {
            console.error("Error al buscar usuarios:", error);
            if (trimmedQuery.length > 0) {
                showError("Failed to search users.");
            }
            setSearchResults([]);
        } finally {
            setIsSearchLoading(false);
        }
    }, [showError, myProfile, setIsSearchLoading, setSearchResults]);

    // useEffect para manejar el retardo
    useEffect(() => {
        const trimmedQuery = searchQuery.trim();

        if (trimmedQuery.length < 2) {
            setSearchResults(prev => {
                if (prev.length > 0) {
                    return [];
                }
                return prev;
            });
            setIsSearchLoading(false);
            lastSearchQueryRef.current = '';
            return;
        }

        // Si la query es la misma que la última exitosa
        if (trimmedQuery === lastSearchQueryRef.current) {
            setIsSearchLoading(false); // Aseguramos que el estado de carga es false
            return;
        }

        // Si es nueva, disparamos el debounce
        const delaySearch = setTimeout(() => {
            executeSearch(trimmedQuery);
        }, 300); // 300ms para un buen UX

        return () => {
            clearTimeout(delaySearch);
        };

        // Este useEffect ahora es estable porque executeSearch es estable.
    }, [searchQuery, executeSearch, setSearchResults, setIsSearchLoading]);

    // --- MANEJADORES DE BÚSQUEDA Y NAVEGACIÓN ---
    const goToFriendProfile = (friend) => {
        setSelectedFriend(friend);
        setCurrentView('profile');
    };

    const goToFriendChat = (friend) => {
        setSelectedFriend(friend);
        setCurrentView('chat');
    };

    // Navegar a mi perfil
    const goToMyProfile = useCallback(async () => {
        if (!myProfile || myProfile.userName === "Guest") {
            try {
                const profileData = await fetchMyProfile();
                setMyProfile(profileData);
            } catch (error) {
                showError("Could not load your profile details. (404 likely)");
            }
        }
        setCurrentView('my_profile');
    }, [myProfile, showError, setMyProfile]); // Dependencias: setMyProfile es estable.

    const goBackToList = () => {
        setSelectedFriend(null);
        setCurrentView('list');
        setSearchResults([]);
        setSearchQuery('');
    };

    const handleStatusChange = (newStatus) => {
        setUserStatus(newStatus);
        setIsDropdownOpen(false);
    };

    const toggleDropdown = () => {
        setIsDropdownOpen(prev => !prev);
    };

    // ***************************************************************
    // --- LÓGICA DE ACCIONES DE AMISTAD (DELETE/ACCEPT/REJECT/ADD) ---
    // ***************************************************************

    const handleDeleteFriendship = useCallback((friendshipId, userName) => {
        const actionFunction = async () => {
            try {
                await deleteFriendship(friendshipId);
                showSuccess(`Friend ${userName} successfully deleted!`);
                setFriends(prevFriends => prevFriends.filter(f => String(f.friendshipId) !== String(friendshipId)));
                goBackToList();
            } catch (error) {
                console.error("Error de red al eliminar amistad:", error);
                showError(error.message || 'Fallo al eliminar amistad.');
            } finally {
                closeModal();
            }
        };

        openModal('confirm', {
            title: "Delete Friend",
            message: `Are you sure you want to remove ${userName} from your friends?`,
            confirmText: "Delete",
            onConfirm: actionFunction,
        });
    }, [showSuccess, showError, closeModal, openModal, setFriends]);

    const handleAddFriend = useCallback(async (user) => {
        try {
            await sendFriendRequest(user.id);
            showSuccess(`Friend request sent to ${user.userName}!`);

            await loadFriendsAndRequests();

            setSearchQuery('');
            setSearchResults([]);

        } catch (error) {
            console.error("Fallo al enviar solicitud:", error);
            showError(error.message || 'Fallo al enviar la solicitud de amistad.');
        }
    }, [showSuccess, showError, loadFriendsAndRequests]);

    const handleAcceptRequest = useCallback(async (friendshipId) => {
        try {
            const acceptedFriendship = await acceptFriendRequest(friendshipId);

            previousPendingRequestIds.current.delete(friendshipId);

            const acceptedRequest = pendingRequests.find(req => String(req.id) === String(friendshipId));

            if (!acceptedRequest) {
                showSuccess("Request accepted. Loading updated list...");
                await loadFriendsAndRequests();
                return;
            }

            const newFriend = {
                id: String(acceptedRequest.sender.id),
                userName: acceptedRequest.sender.userName,
                avatarUrl: acceptedRequest.sender.avatarUrl,
                status: 'online',
                friendshipId: acceptedFriendship.id || friendshipId,
            };

            setPendingRequests(prev => prev.filter(req => String(req.id) !== String(friendshipId)));
            setFriends(prev => [...prev, newFriend]);

            showSuccess(`${newFriend.userName} is your new CaFriend!`);

        } catch (error) {
            console.error("Fallo al aceptar solicitud:", error);
            showError(error.message || "Failed to accept friend request.");
        }
    }, [pendingRequests, loadFriendsAndRequests, showSuccess, showError, setPendingRequests, setFriends]);

    const handleRejectRequest = useCallback(async (friendshipId) => {
        try {
            await rejectFriendRequest(friendshipId);

            previousPendingRequestIds.current.delete(friendshipId);

            setPendingRequests(prev => prev.filter(req => String(req.id) !== String(friendshipId)));

            showSuccess(`Friend request rejected successfully!`);

        } catch (error) {
            console.error("Fallo al rechazar solicitud:", error);
            showError(error.message || "Failed to reject friend request.");
        }
    }, [showSuccess, showError, setPendingRequests]);

    // ***************************************************************
    // --- LÓGICA DE EDICIÓN DE MI PERFIL ---
    // ***************************************************************

    const handleSaveMyProfile = useCallback(async (updateData) => {
        setIsLoading(true);
        try {
            const updatedProfile = await updateMyProfile(updateData);
            setMyProfile(updatedProfile);
            showSuccess('Profile successfully updated!');
        } catch (error) {
            console.error("Fallo al guardar perfil:", error);
            showError(error.message || "Failed to save profile changes.");
        } finally {
            setIsLoading(false);
        }
    }, [showSuccess, showError, setMyProfile, setIsLoading]);


    // --- LÓGICA DE FILTRADO Y VISUALIZACIÓN ---
    const getFilteredUsers = useCallback(() => {
        if (isSearching) {
            return searchResults;
        } else {
            const allFriends = friends;

            const sortedFriends = [...allFriends].sort((a, b) => {
                const statusA = a.status === 'online' ? 1 : 0;
                const statusB = b.status === 'online' ? 1 : 0;

                if (statusB !== statusA) {
                    return statusB - statusA;
                }

                return a.userName.localeCompare(b.userName);
            });

            return sortedFriends;
        }
    }, [isSearching, searchResults, friends]);

    const displayedUsers = getFilteredUsers();

    // --- RENDERIZADO DEL CONTENIDO DINÁMICO ---
    const statusOptions = [
        { value: 'online', label: 'Online' },
        { value: 'offline', label: 'Offline' },
    ];

    const renderContent = () => {
        if (currentView === 'my_profile') {
            if (!myProfile || myProfile.userName === "Guest") {
                return (
                    <div className="dynamic-view profile-view">
                        <button onClick={goBackToList} className="back-button">
                            <IoArrowBackCircle size={28} color="#90b484" />
                            <h4>Return to Friends</h4>
                        </button>
                        <h2 style={{ color: '#e96765' }}>Error</h2>
                        <p style={{ textAlign: 'center' }}>
                            Could not load your profile details. Please verify that the
                            **GET /users/me** endpoint is correctly implemented and accessible on the server.
                        </p>
                    </div>
                );
            }

            return (
                <MyProfileView
                    myUser={myProfile}
                    onBack={goBackToList}
                    onSaveProfile={handleSaveMyProfile}
                    isLoading={isLoading}
                />
            );
        }

        if (currentView === 'profile' && selectedFriend) {
            return (
                <FriendProfileView
                    friend={selectedFriend}
                    onBack={goBackToList}
                    onGoToChat={goToFriendChat}
                    onDeleteFriend={handleDeleteFriendship}
                />
            );
        }
        if (currentView === 'chat' && selectedFriend) {
            return (
                <FriendChatView
                    friend={selectedFriend}
                    onBack={goBackToList}
                    onGoToProfile={goToFriendProfile}
                />
            );
        }

        return (
            <>
                {/* BARRA DE BÚSQUEDA Y STATUS */}
                <div className='friends-menu-search-bar'>
                    <input
                        type="text"
                        placeholder="Search user..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {/* INDICADOR DE BÚSQUEDA EN TIEMPO REAL (comentado) */}
                </div>
                {/* FIN BARRA DE BÚSQUEDA Y STATUS */}

                {/* LISTA DE AMIGOS / RESULTADOS DE BÚSQUEDA */}
                <div className="friend-list-container">

                    {/* SECCIÓN DE SOLICITUDES PENDIENTES */}
                    {pendingRequests.length > 0 && !isSearching && (
                        <div className="pending-requests-section">
                            <h3 className="list-title">Friend Requests ({pendingRequests.length})</h3>
                            {pendingRequests.map(request => (
                                <FriendRequestCard
                                    key={request.id}
                                    request={request}
                                    onAccept={handleAcceptRequest}
                                    onReject={handleRejectRequest}
                                />
                            ))}
                        </div>
                    )}

                    {/* TÍTULO CONDICIONAL DE LA LISTA PRINCIPAL */}
                    {!isSearching && <h3 className="list-title">My Friends ({friends.length})</h3>}
                    {isSearching && <h3 className="list-title">Search Results ({searchResults.length})</h3>}

                    {isSearchLoading ? (
                        <Loader />
                    ) : displayedUsers.length > 0 ? (
                        displayedUsers.map(user => (
                            <FriendCard
                                key={user.id}
                                user={user}
                                isFriend={friendIds.has(user.id)}
                                onGoToProfile={goToFriendProfile}
                                onGoToChat={goToFriendChat}
                                onAddFriend={handleAddFriend}
                            />
                        ))
                    ) : (
                        <p className="no-friends-message">
                            {isSearching ? 'Users not found.' : 'Don\'t have friends yet.'}
                        </p>
                    )}
                </div>
            </>
        );
    };

    if (!isAuthenticated) return null;

    return (
        // 3. ADJUNTAR LA REFERENCIA AL CONTENEDOR PRINCIPAL
        <div className={`friends-menu ${collapsedClass}`} ref={menuRef}>
            <button
                onClick={toggleFriendMenu}
                aria-expanded={isFriendMenuOpen}
                aria-controls="friend-list-content"
                className='openFriendMenu'
            >
                <FaUserFriends size={30} color="#f08c52" />
            </button>

            {isFriendMenuOpen && (
                <div className='friend-menu-content'>
                    <header>
                        <h2>
                            {currentView !== 'list' && selectedFriend ? selectedFriend.userName + " Profile" :
                                currentView === 'my_profile' ? 'Your Profile' : 'CaTube Social'}
                        </h2>
                        <div className='header-divider-social-menu'>
                            {(currentView === 'list') && (
                                <button
                                    onClick={goToMyProfile}
                                    className="my-profile-button"
                                    title="View and edit my profile"
                                    disabled={isLoading}
                                >
                                    You
                                </button>
                            )}

                            <button onClick={toggleFriendMenu}>
                                <IoIosCloseCircle size={30} color="#f08c52" />
                            </button>
                        </div>

                    </header>

                    {renderContent()}
                </div>
            )}
        </div>
    );
}