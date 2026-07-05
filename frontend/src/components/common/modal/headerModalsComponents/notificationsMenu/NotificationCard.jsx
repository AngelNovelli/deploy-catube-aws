import React from 'react';
import { useNavigate } from 'react-router-dom';
import logo from '/public/catube_logo.png'

// Styles
import './NotificationMenu.css';
import { MdDelete } from "react-icons/md";
import { useSidebarToggle } from '../../../../../hooks/useSidebarToggleFriends';

// Función para formatear la fecha (se mantiene igual)
const formatNotificationTime = (timestamp) => {
    const now = new Date();
    const date = new Date(timestamp);
    const diffInSeconds = Math.floor((now - date) / 1000);
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    const diffInHours = Math.floor(diffInMinutes / 60);
    const diffInDays = Math.floor(diffInHours / 24);

    if (diffInSeconds < 60) return "Just now";
    if (diffInMinutes < 60) return `${diffInMinutes} minute${diffInMinutes === 1 ? '' : 's'} ago`;
    if (diffInHours < 24) return `${diffInHours} hour${diffInHours === 1 ? '' : 's'} ago`;
    if (diffInDays < 7) return `${diffInDays} day${diffInDays === 1 ? '' : 's'} ago`;

    // Si es más de 7 días, mostrar la fecha completa (ej. 15 Jan 2023)
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

export function NotificationCard({ notification, onMarkAsRead, onDelete, onCloseNotificationMenu }) {
    const navigate = useNavigate();

    const { openFriendMenu } = useSidebarToggle();
    const { id, type, sender, read, createdAt, linkTarget, content } = notification;

    const isWelcomeNotification = content.startsWith('Welcome');

    // Obtenemos los datos del emisor, asegurándonos de manejar el caso donde 'sender' es null
    const senderUsername = sender?.username || 'El sistema';
    const senderAvatarUrl = sender?.avatarUrl || 'default_avatar_path.png';

    const handleNotificationClick = () => {
        onMarkAsRead(id);

        if (type === 'friend_request' || type === 'friend_accepted' || type === 'message') {
            openFriendMenu();

            if (onCloseNotificationMenu) {
                onCloseNotificationMenu();
            }

        } else if (linkTarget) {
            navigate(linkTarget);

            if (onCloseNotificationMenu) {
                onCloseNotificationMenu();
            }

        } else {
            // Acción por defecto o log
            console.log(`Notification action for ID ${id} not handled.`);
        }
    };

    const handleDeleteClick = () => {
        if (onDelete) {
            onDelete(id);
        }
    };

    return (
        <div className={`notifications-container ${read ? 'read' : ''}`}>
            <div
                className={`notification-item ${isWelcomeNotification ? 'welcome-notification' : ''}`}
            >
                <img
                    src={isWelcomeNotification ? logo : senderAvatarUrl}
                    alt={`${senderUsername} avatar`}
                    className="notification-avatar"
                />
                <div className="notification-content">
                    <p className="notification-text" onClick={handleNotificationClick}>
                        {isWelcomeNotification ? 'Welcome to CaTube!' : `${senderUsername} ${content}`}
                    </p>
                    <span className="notification-time">
                        {formatNotificationTime(createdAt)}
                    </span>
                </div>

            </div>
            {/* Botón de acción principal: "Go" */}
            {!isWelcomeNotification && (
                <button className="btn-link" onClick={handleNotificationClick}>
                    Go
                </button>
            )}

            {/* BOTÓN DE BORRAR IMPLEMENTADO */}
            <button
                onClick={handleDeleteClick}
                title="Delete Notification"
                className="delete-notification-button"
            >
                <MdDelete size={24} color="#1a1a1b" />
            </button>
        </div>
    );
}